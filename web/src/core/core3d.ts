import * as THREE from 'three';
import { STATE_PARAMS, lerpParams, type CoreInput, type CoreParams, type CoreRenderer } from './params';

/**
 * The living computational core (Three.js / WebGL2).
 *
 * Built for an A12 iPad: no post-processing, no shadows, no lights — glow is
 * faked with additive fresnel shaders and a billboard. Particle orbits are
 * computed in the vertex shader from accumulated phases, so the CPU only
 * updates a handful of uniforms per frame. Resolution adapts to the measured
 * frame rate; persistent low FPS asks the host to fall back to 2D.
 */

const NOISE = /* glsl */ `
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0); const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g; vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx; vec3 x2=x0-i2+C.yyy; vec3 x3=x0-D.yyy; i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857; vec3 ns=n_*D.wyz-D.xzx; vec4 j=p-49.0*floor(p*ns.z*ns.z);
  vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_); vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw); vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0; vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3))); p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0); m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}`;

const CYAN = new THREE.Color('#2ee6ff');
const ICE = new THREE.Color('#a8dcff');
const VIOLET = new THREE.Color('#8f7bff');
const AMBER = new THREE.Color('#ffb648');
const NUCLEUS = new THREE.Color('#e8fdff');

export interface Core3DOptions {
  batterySaver: boolean;
  onTooSlow: () => void;
}

export class Core3D implements CoreRenderer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
  private root = new THREE.Group();
  private raf = 0;
  private running = false;
  private last = 0;
  private params: CoreParams = { ...STATE_PARAMS.idle };
  private input: CoreInput = { state: 'idle', level: 0, activeAgents: [], reducedMotion: false };
  private level = 0;
  private phase = { core: 0, rings: 0, particles: 0, neural: 0, nodes: 0, paths: 0, pulse: 0 };
  private pixelRatio: number;
  private frameTimes: number[] = [];
  private slowWindows = 0;
  private disposables: { dispose(): void }[] = [];

  private coreMat!: THREE.ShaderMaterial;
  private nucleus!: THREE.Mesh;
  private glow!: THREE.Mesh;
  private glowMat!: THREE.ShaderMaterial;
  private neuralMat!: THREE.ShaderMaterial;
  private nodeMat!: THREE.ShaderMaterial;
  private rings: { mesh: THREE.LineLoop; mat: THREE.ShaderMaterial; dir: number; speed: number; baseScale: number }[] = [];
  private cages: { obj: THREE.LineSegments; mat: THREE.LineBasicMaterial; axis: THREE.Vector3; speed: number }[] = [];
  private particleMat!: THREE.ShaderMaterial;
  private pathMats: THREE.ShaderMaterial[] = [];
  private agentNodes: THREE.Mesh[] = [];
  private bezel!: THREE.Points;

  constructor(
    private canvas: HTMLCanvasElement,
    private opts: Core3DOptions,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, powerPreference: 'high-performance', premultipliedAlpha: false });
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, opts.batterySaver ? 1 : 1.5);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setClearColor(0x000000, 0);
    this.camera.position.set(0, 0.4, 9.5);
    this.camera.lookAt(0, 0, 0);
    this.scene.add(this.root);
    this.root.rotation.x = 0.18;
    this.build();
    canvas.addEventListener('webglcontextlost', this.onContextLost, false);
  }

  private onContextLost = (e: Event) => {
    e.preventDefault();
    this.stop();
    this.opts.onTooSlow();
  };

  private track<T extends { dispose(): void }>(x: T): T {
    this.disposables.push(x);
    return x;
  }

  private build() {
    // --- core sphere --------------------------------------------------------
    const coreGeo = this.track(new THREE.IcosahedronGeometry(1.15, 4));
    this.coreMat = this.track(
      new THREE.ShaderMaterial({
        uniforms: { uTime: { value: 0 }, uDisp: { value: 0.04 }, uLevel: { value: 0 }, uColA: { value: CYAN.clone() }, uColB: { value: VIOLET.clone() }, uWarn: { value: AMBER.clone() }, uTint: { value: 0 }, uGlow: { value: 0.8 }, uViolet: { value: 0.2 } },
        vertexShader: `${NOISE}
          uniform float uTime; uniform float uDisp; uniform float uLevel;
          varying vec3 vNormal; varying vec3 vView; varying float vNoise;
          void main(){
            float n = snoise(position*1.5 + vec3(uTime*0.35));
            float n2 = snoise(position*3.6 - vec3(uTime*0.55));
            float d = (n*0.7 + n2*0.3) * (uDisp + uLevel*0.14);
            vec3 p = position + normal*d;
            vNoise = n;
            vec4 mv = modelViewMatrix*vec4(p,1.0);
            vView = -mv.xyz;
            vNormal = normalize(normalMatrix*normal);
            gl_Position = projectionMatrix*mv;
          }`,
        fragmentShader: `
          uniform vec3 uColA; uniform vec3 uColB; uniform vec3 uWarn; uniform float uTint; uniform float uGlow; uniform float uTime; uniform float uViolet;
          varying vec3 vNormal; varying vec3 vView; varying float vNoise;
          void main(){
            vec3 n = normalize(vNormal); vec3 v = normalize(vView);
            float fres = pow(1.0 - max(dot(n,v),0.0), 2.3);
            vec3 base = mix(uColA, uColB, clamp(uViolet*0.7 + vNoise*0.3, 0.0, 1.0));
            base = mix(base, uWarn, uTint);
            float bands = 0.5 + 0.5*sin(vNoise*16.0 + uTime*1.8);
            vec3 col = base*(0.12 + 0.22*bands) + base*fres*1.7;
            gl_FragColor = vec4(col*uGlow, (0.28 + fres*0.72)*uGlow);
          }`,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.root.add(new THREE.Mesh(coreGeo, this.coreMat));

    // --- nucleus --------------------------------------------------------------
    const nucMat = this.track(new THREE.MeshBasicMaterial({ color: 0xe8fdff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.nucleus = new THREE.Mesh(this.track(new THREE.IcosahedronGeometry(0.34, 2)), nucMat);
    this.root.add(this.nucleus);

    // --- billboard glow --------------------------------------------------------
    this.glowMat = this.track(
      new THREE.ShaderMaterial({
        uniforms: { uCol: { value: CYAN.clone() }, uGlow: { value: 0.8 } },
        vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
        fragmentShader: `uniform vec3 uCol; uniform float uGlow; varying vec2 vUv;
          void main(){ float d = length(vUv-0.5)*2.0; float a = pow(max(1.0-d,0.0), 2.6)*0.55*uGlow; gl_FragColor = vec4(uCol*a, a); }`,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.glow = new THREE.Mesh(this.track(new THREE.PlaneGeometry(7.5, 7.5)), this.glowMat);
    this.scene.add(this.glow);

    // --- neural shell ------------------------------------------------------------
    const N = this.opts.batterySaver ? 70 : 120;
    const pts: THREE.Vector3[] = [];
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < N; i++) {
      const y = 1 - (i / (N - 1)) * 2;
      const r = Math.sqrt(1 - y * y);
      const th = golden * i;
      const rad = 1.72 + (Math.random() - 0.5) * 0.18;
      pts.push(new THREE.Vector3(Math.cos(th) * r * rad, y * rad, Math.sin(th) * r * rad));
    }
    const segs: number[] = [];
    const tAttr: number[] = [];
    const phAttr: number[] = [];
    const seen = new Set<string>();
    pts.forEach((p, i) => {
      const near = pts.map((q, j) => ({ j, d: p.distanceToSquared(q) })).filter((x) => x.j !== i).sort((a, b) => a.d - b.d).slice(0, 3);
      for (const { j } of near) {
        const key = i < j ? `${i}-${j}` : `${j}-${i}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const q = pts[j];
        segs.push(p.x, p.y, p.z, q.x, q.y, q.z);
        tAttr.push(0, 1);
        const ph = Math.random();
        phAttr.push(ph, ph);
      }
    });
    const neuralGeo = this.track(new THREE.BufferGeometry());
    neuralGeo.setAttribute('position', new THREE.Float32BufferAttribute(segs, 3));
    neuralGeo.setAttribute('aT', new THREE.Float32BufferAttribute(tAttr, 1));
    neuralGeo.setAttribute('aPhase', new THREE.Float32BufferAttribute(phAttr, 1));
    this.neuralMat = this.track(
      new THREE.ShaderMaterial({
        uniforms: { uPhase: { value: 0 }, uNeural: { value: 0.1 }, uCol: { value: ICE.clone() }, uWarn: { value: AMBER.clone() }, uTint: { value: 0 } },
        vertexShader: `attribute float aT; attribute float aPhase; varying float vT; varying float vPh; void main(){ vT=aT; vPh=aPhase; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
        fragmentShader: `uniform float uPhase; uniform float uNeural; uniform vec3 uCol; uniform vec3 uWarn; uniform float uTint; varying float vT; varying float vPh;
          void main(){ float head = fract(uPhase + vPh*7.0); float d = abs(vT-head); float pulse = smoothstep(0.22, 0.0, d)*uNeural*step(0.35, fract(vPh*13.0));
            vec3 c = mix(uCol, uWarn, uTint); float a = 0.05 + 0.08*uNeural + pulse*0.9; gl_FragColor = vec4(c*a, a); }`,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.root.add(new THREE.LineSegments(neuralGeo, this.neuralMat));

    // information nodes
    const nodeGeo = this.track(new THREE.BufferGeometry());
    nodeGeo.setFromPoints(pts);
    nodeGeo.setAttribute('aId', new THREE.Float32BufferAttribute(pts.map((_, i) => i), 1));
    this.nodeMat = this.track(
      new THREE.ShaderMaterial({
        uniforms: { uNodes: { value: 0.1 }, uTick: { value: 0 }, uPR: { value: this.pixelRatio }, uCol: { value: CYAN.clone() }, uWarn: { value: AMBER.clone() }, uTint: { value: 0 } },
        vertexShader: `attribute float aId; uniform float uNodes; uniform float uTick; uniform float uPR; varying float vOn;
          void main(){ float r = fract(sin(aId*12.9898 + floor(uTick)*78.233)*43758.5453); vOn = step(1.0 - uNodes*0.35, r);
            vec4 mv = modelViewMatrix*vec4(position,1.0); gl_PointSize = (2.0 + vOn*5.0)*uPR*(9.0/-mv.z); gl_Position = projectionMatrix*mv; }`,
        fragmentShader: `uniform vec3 uCol; uniform vec3 uWarn; uniform float uTint; varying float vOn;
          void main(){ float d = length(gl_PointCoord-0.5); if(d>0.5) discard; float a = (0.35 + vOn*0.65)*(1.0-d*1.8); gl_FragColor = vec4(mix(uCol,uWarn,uTint)*a*(1.0+vOn), a); }`,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.root.add(new THREE.Points(nodeGeo, this.nodeMat));

    // --- orbital rings ---------------------------------------------------------------
    const ringDefs = [
      { r: 2.35, tilt: [1.2, 0.2, 0], dir: 1, speed: 1.0, dashes: 48, col: ICE },
      { r: 2.7, tilt: [0.4, -0.6, 0.3], dir: -1, speed: 0.7, dashes: 2, col: CYAN },
      { r: 3.05, tilt: [-0.9, 0.4, -0.2], dir: 1, speed: 0.5, dashes: 96, col: VIOLET },
      { r: 3.45, tilt: [1.45, 0, 0.6], dir: -1, speed: 0.35, dashes: 6, col: CYAN },
    ];
    for (const d of ringDefs) {
      const n = 256;
      const pos: number[] = [];
      const ang: number[] = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        pos.push(Math.cos(a) * d.r, 0, Math.sin(a) * d.r);
        ang.push(a);
      }
      const g = this.track(new THREE.BufferGeometry());
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('aA', new THREE.Float32BufferAttribute(ang, 1));
      const mat = this.track(
        new THREE.ShaderMaterial({
          uniforms: { uPhase: { value: 0 }, uDashes: { value: d.dashes }, uCol: { value: d.col.clone() }, uWarn: { value: AMBER.clone() }, uTint: { value: 0 }, uBright: { value: 0.7 } },
          vertexShader: `attribute float aA; varying float vA; void main(){ vA=aA; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
          fragmentShader: `uniform float uPhase; uniform float uDashes; uniform vec3 uCol; uniform vec3 uWarn; uniform float uTint; uniform float uBright; varying float vA;
            void main(){ float f = fract(vA/6.2831853*uDashes - uPhase); float on = uDashes < 4.0 ? smoothstep(0.0,0.6,f)*0.9 : step(0.45,f);
              float a = (0.12 + on*0.55)*uBright; gl_FragColor = vec4(mix(uCol,uWarn,uTint)*a, a); }`,
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      const mesh = new THREE.LineLoop(g, mat);
      mesh.rotation.set(d.tilt[0], d.tilt[1], d.tilt[2]);
      this.root.add(mesh);
      this.rings.push({ mesh, mat, dir: d.dir, speed: d.speed, baseScale: 1 });
    }

    // bezel ticks (watch-like)
    const tick: THREE.Vector3[] = [];
    for (let i = 0; i < 120; i++) {
      const a = (i / 120) * Math.PI * 2;
      const r = i % 10 === 0 ? 3.95 : 3.9;
      tick.push(new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, 0));
    }
    const bezelMat = this.track(new THREE.PointsMaterial({ color: ICE, size: 0.035, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.bezel = new THREE.Points(this.track(new THREE.BufferGeometry().setFromPoints(tick)), bezelMat);
    this.scene.add(this.bezel);

    // --- geometric cages ------------------------------------------------------------
    const cageDefs = [
      { geo: new THREE.OctahedronGeometry(1.5, 0), opacity: 0.2, axis: new THREE.Vector3(0.3, 1, 0.1), speed: 0.6, col: CYAN },
      { geo: new THREE.DodecahedronGeometry(2.05, 0), opacity: 0.12, axis: new THREE.Vector3(-0.4, 1, 0.3), speed: -0.35, col: VIOLET },
    ];
    for (const c of cageDefs) {
      const edges = this.track(new THREE.EdgesGeometry(c.geo));
      c.geo.dispose();
      const mat = this.track(new THREE.LineBasicMaterial({ color: c.col, transparent: true, opacity: c.opacity, blending: THREE.AdditiveBlending, depthWrite: false }));
      const obj = new THREE.LineSegments(edges, mat);
      this.root.add(obj);
      this.cages.push({ obj, mat, axis: c.axis.normalize(), speed: c.speed });
    }

    // --- particles ------------------------------------------------------------------
    const P = this.opts.batterySaver ? 700 : 1600;
    const seeds = new Float32Array(P * 4);
    for (let i = 0; i < P; i++) {
      seeds[i * 4] = 2.0 + Math.random() ** 0.7 * 2.6;
      seeds[i * 4 + 1] = Math.random() * Math.PI * 2;
      seeds[i * 4 + 2] = (Math.random() - 0.5) * (0.25 + Math.random() * 0.9);
      seeds[i * 4 + 3] = 0.4 + Math.random();
    }
    const pg = this.track(new THREE.BufferGeometry());
    pg.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(P * 3), 3));
    pg.setAttribute('aSeed', new THREE.Float32BufferAttribute(seeds, 4));
    pg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 6);
    this.particleMat = this.track(
      new THREE.ShaderMaterial({
        uniforms: { uPhase: { value: 0 }, uTime: { value: 0 }, uTurb: { value: 0.05 }, uScale: { value: 1 }, uPR: { value: this.pixelRatio }, uColA: { value: CYAN.clone() }, uColB: { value: ICE.clone() }, uWarn: { value: AMBER.clone() }, uTint: { value: 0 } },
        vertexShader: `attribute vec4 aSeed; uniform float uPhase; uniform float uTime; uniform float uTurb; uniform float uScale; uniform float uPR; varying float vMix; varying float vFade;
          void main(){
            float a = aSeed.y + uPhase*aSeed.w*(2.4/aSeed.x);
            float r = aSeed.x*mix(1.0, uScale, 0.6);
            float h = aSeed.z + sin(uTime*0.8 + aSeed.y*5.0)*uTurb;
            vec3 p = vec3(cos(a)*r, h, sin(a)*r);
            float tilt = 0.35*sin(aSeed.y*3.0);
            p.yz = mat2(cos(tilt), -sin(tilt), sin(tilt), cos(tilt))*p.yz;
            vMix = fract(aSeed.w*7.0); vFade = 0.55 + 0.45*sin(uTime*2.0 + aSeed.y*11.0);
            vec4 mv = modelViewMatrix*vec4(p,1.0);
            gl_PointSize = (1.2 + vMix*1.6)*uPR*(9.0/-mv.z);
            gl_Position = projectionMatrix*mv;
          }`,
        fragmentShader: `uniform vec3 uColA; uniform vec3 uColB; uniform vec3 uWarn; uniform float uTint; varying float vMix; varying float vFade;
          void main(){ float d = length(gl_PointCoord-0.5); if(d>0.5) discard; vec3 c = mix(mix(uColA,uColB,vMix), uWarn, uTint); float a = (1.0-d*2.0)*0.75*vFade; gl_FragColor = vec4(c*a, a); }`,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.root.add(new THREE.Points(pg, this.particleMat));

    // --- information pathways to the six agent nodes -----------------------------------
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
      const end = new THREE.Vector3(Math.cos(a) * 4.6, Math.sin(a) * 0.9, Math.sin(a) * 4.6 * 0.55);
      const start = end.clone().normalize().multiplyScalar(1.25);
      const ctrl = start.clone().lerp(end, 0.5).add(new THREE.Vector3(0, 1.1 * (i % 2 ? 1 : -1), 0));
      const curve = new THREE.QuadraticBezierCurve3(start, ctrl, end);
      const cp = curve.getPoints(48);
      const g = this.track(new THREE.BufferGeometry().setFromPoints(cp));
      g.setAttribute('aT', new THREE.Float32BufferAttribute(cp.map((_, k) => k / 48), 1));
      const mat = this.track(
        new THREE.ShaderMaterial({
          uniforms: { uPhase: { value: 0 }, uOn: { value: 0 }, uCol: { value: i % 2 ? VIOLET.clone() : CYAN.clone() } },
          vertexShader: `attribute float aT; varying float vT; void main(){ vT=aT; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
          fragmentShader: `uniform float uPhase; uniform float uOn; uniform vec3 uCol; varying float vT;
            void main(){ float head = fract(uPhase); float p = smoothstep(0.16, 0.0, abs(vT-head)) + smoothstep(0.16,0.0,abs(vT-fract(head+0.5)))*0.6;
              float a = 0.04 + uOn*(0.12 + p*0.85); gl_FragColor = vec4(uCol*a, a); }`,
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      this.root.add(new THREE.Line(g, mat));
      this.pathMats.push(mat);
      const nodeMat = this.track(new THREE.MeshBasicMaterial({ color: i % 2 ? VIOLET : CYAN, wireframe: true, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }));
      const node = new THREE.Mesh(this.track(new THREE.OctahedronGeometry(0.13, 0)), nodeMat);
      node.position.copy(end);
      this.root.add(node);
      this.agentNodes.push(node);
    }
  }

  update(input: CoreInput) {
    this.input = input;
  }

  resize(w: number, h: number) {
    if (w <= 0 || h <= 0) return;
    this.renderer.setSize(w, h, false);
    const aspect = w / h;
    this.camera.aspect = aspect;
    // Fit the orbital rings (radius ≈ 3.6) to the narrower dimension; outer agent
    // nodes may drift past the edge in tall, narrow layouts.
    const halfFov = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const fitWidth = 3.75 / (halfFov * aspect);
    this.camera.position.z = Math.max(9.5, Math.min(18, fitWidth));
    this.camera.updateProjectionMatrix();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  private frame = (now: number) => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.frame);
    const minFrame = this.opts.batterySaver ? 1000 / 31 : 0;
    const elapsed = now - this.last;
    if (elapsed < minFrame) return;
    const dt = Math.min(0.1, elapsed / 1000);
    this.last = now;
    this.measure(elapsed);

    const motion = this.input.reducedMotion ? 0.35 : 1;
    const target = STATE_PARAMS[this.input.state];
    this.params = lerpParams(this.params, target, 1 - Math.exp(-dt * 3.2));
    this.level += (this.input.level - this.level) * (1 - Math.exp(-dt * 10));
    const p = this.params;
    const ph = this.phase;
    ph.core += dt * p.spin * motion;
    ph.rings += dt * p.ringSpeed * motion;
    ph.particles += dt * p.particleSpeed * motion;
    ph.neural += dt * (0.25 + p.neural * 0.9) * motion;
    ph.nodes += dt * (0.6 + p.nodes * 4) * motion;
    ph.paths += dt * (0.3 + p.pathways * 0.9) * motion;
    ph.pulse += dt * p.pulseRate * motion;
    const t = now / 1000;

    const u = this.coreMat.uniforms;
    u.uTime.value = t * motion;
    u.uDisp.value = p.displacement;
    u.uLevel.value = this.level;
    u.uTint.value = p.tint;
    u.uGlow.value = p.glow + this.level * 0.25;
    u.uViolet.value = p.violet;

    const pulse = 1 + Math.sin(ph.pulse * Math.PI * 2) * 0.06 + this.level * 0.18;
    this.nucleus.scale.setScalar(pulse);
    (this.nucleus.material as THREE.MeshBasicMaterial).color.copy(NUCLEUS).lerp(AMBER, p.tint * 0.6);
    this.root.rotation.y = ph.core;

    this.glow.quaternion.copy(this.camera.quaternion);
    this.glowMat.uniforms.uGlow.value = p.glow * (0.85 + this.level * 0.4);
    (this.glowMat.uniforms.uCol.value as THREE.Color).copy(CYAN).lerp(VIOLET, p.violet * 0.4).lerp(AMBER, p.tint);

    this.neuralMat.uniforms.uPhase.value = ph.neural;
    this.neuralMat.uniforms.uNeural.value = p.neural;
    this.neuralMat.uniforms.uTint.value = p.tint;
    this.nodeMat.uniforms.uNodes.value = p.nodes;
    this.nodeMat.uniforms.uTick.value = ph.nodes;
    this.nodeMat.uniforms.uTint.value = p.tint;
    this.nodeMat.uniforms.uPR.value = this.pixelRatio;

    const ringScale = p.ringScale - this.level * 0.08;
    this.rings.forEach((r, i) => {
      r.mesh.rotateY(dt * r.speed * r.dir * p.ringSpeed * 1.4 * motion);
      const wobble = 1 + Math.sin(t * 6 + i) * this.level * 0.025;
      r.mesh.scale.setScalar(ringScale * wobble);
      r.mat.uniforms.uPhase.value = ph.rings * r.dir * (i + 1) * 0.6;
      r.mat.uniforms.uTint.value = p.tint;
      r.mat.uniforms.uBright.value = 0.55 + p.glow * 0.35 + this.level * 0.4;
    });
    this.bezel.rotation.z = -ph.rings * 0.15;
    this.bezel.scale.setScalar(0.98 + (ringScale - 1) * 0.3);

    for (const c of this.cages) {
      c.obj.rotateOnAxis(c.axis, dt * c.speed * (0.4 + p.spin * 2) * motion);
      c.mat.color.copy(c.speed > 0 ? CYAN : VIOLET).lerp(AMBER, p.tint);
    }

    const pu = this.particleMat.uniforms;
    pu.uPhase.value = ph.particles;
    pu.uTime.value = t * motion;
    pu.uTurb.value = p.turbulence + this.level * 0.15;
    pu.uScale.value = ringScale;
    pu.uTint.value = p.tint;
    pu.uPR.value = this.pixelRatio;

    this.pathMats.forEach((m, i) => {
      const on = this.input.activeAgents.includes(i) ? 1 : p.pathways * 0.25;
      m.uniforms.uOn.value += (on - m.uniforms.uOn.value) * (1 - Math.exp(-dt * 4));
      m.uniforms.uPhase.value = ph.paths + i * 0.17;
      const node = this.agentNodes[i];
      node.rotation.y += dt * (0.5 + on * 2);
      node.scale.setScalar(1 + on * 0.6 + Math.sin(t * 4 + i) * on * 0.15);
      (node.material as THREE.MeshBasicMaterial).opacity = 0.25 + on * 0.6;
    });

    this.renderer.render(this.scene, this.camera);
  };

  /** Adaptive resolution; persistent low FPS → host falls back to 2D. */
  private measure(elapsedMs: number) {
    if (document.hidden) return;
    this.frameTimes.push(elapsedMs);
    if (this.frameTimes.length < 90) return;
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    this.frameTimes = [];
    const fps = 1000 / avg;
    const target = this.opts.batterySaver ? 26 : 45;
    if (fps < target && this.pixelRatio > 0.75) {
      this.pixelRatio = Math.max(0.75, this.pixelRatio - 0.25);
      this.renderer.setPixelRatio(this.pixelRatio);
      const size = this.renderer.getSize(new THREE.Vector2());
      this.renderer.setSize(size.x, size.y, false);
    } else if (fps < 24) {
      if (++this.slowWindows >= 3) {
        this.stop();
        this.opts.onTooSlow();
      }
    } else this.slowWindows = 0;
  }

  get stats() {
    return { pixelRatio: this.pixelRatio };
  }

  dispose() {
    this.stop();
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    for (const d of this.disposables) d.dispose();
    this.renderer.dispose();
  }
}

export function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!c.getContext('webgl2');
  } catch {
    return false;
  }
}
