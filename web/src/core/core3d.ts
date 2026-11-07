import * as THREE from 'three';
import type { GraphicsQuality } from '@tc/shared';
import { BOOT_SECONDS, DEFAULT_INPUT, STATE_PARAMS, coreStats, lerpParams, stage, type CoreInput, type CoreParams, type CoreRenderer } from './params';

/**
 * The TOURBILLION core (Three.js / WebGL2).
 *
 * Everything is additive light: no lights, no shadows, no textures. Motion is
 * computed in vertex shaders from accumulated phases, so the CPU only updates
 * uniforms per frame. Three quality tiers trade particle counts, resolution
 * and (Cinematic only) a bloom pass for frame rate; measured FPS degrades the
 * tier further and, as a last resort, asks the host to fall back to 2D.
 *
 * Layers, inside out: nucleus and tourbillon gimbal → chromatic fresnel core →
 * wireframe grid sphere with a latitude scan beam → neural shell → geometric
 * cages → tilted orbital rings carrying energy beads → screen-plane reticles
 * and bezel → orbiting particles, data fragments and floating solids →
 * pathways to the seven agent nodes → expanding energy waves and a radar sweep.
 */

// Colours are authored as display values; keep three from re-encoding them.
THREE.ColorManagement.enabled = false;

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

/** Shared state colouring: emerald on success, controlled red on error. */
const STATE_GLSL = /* glsl */ `
uniform float uTint; uniform float uOk; uniform float uTime; uniform float uPR;
vec3 stateCol(vec3 c){
  float l = max(c.r, max(c.g, c.b));
  c = mix(c, vec3(0.24, 1.0, 0.69) * l, uOk * 0.85);
  return mix(c, vec3(1.0, 0.30, 0.37) * l, uTint * 0.9);
}`;

const C = {
  cyan: new THREE.Color('#2ee6ff'),
  turq: new THREE.Color('#1ff2d2'),
  holo: new THREE.Color('#4f8dff'),
  ice: new THREE.Color('#a8dcff'),
  violet: new THREE.Color('#8f7bff'),
  deep: new THREE.Color('#0a2463'),
  emerald: new THREE.Color('#3dffb0'),
  red: new THREE.Color('#ff4d5e'),
  white: new THREE.Color('#eafcff'),
};

interface Tier {
  dpr: number;
  particles: number;
  fragments: number;
  neural: number;
  floaters: number;
  bloom: boolean;
  fpsCap: number;
  target: number;
}

export const TIERS: Record<GraphicsQuality, Tier> = {
  cinematic: { dpr: 2, particles: 2600, fragments: 140, neural: 140, floaters: 8, bloom: true, fpsCap: 0, target: 50 },
  balanced: { dpr: 1.5, particles: 1600, fragments: 90, neural: 110, floaters: 6, bloom: false, fpsCap: 0, target: 45 },
  performance: { dpr: 1, particles: 650, fragments: 40, neural: 70, floaters: 3, bloom: false, fpsCap: 31, target: 26 },
};

export interface Core3DOptions {
  quality: GraphicsQuality;
  onTooSlow: () => void;
}

const TAU = Math.PI * 2;
const VERT_UV = /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`;
const easeOutBack = (k: number) => 1 + 2.70158 * (k - 1) ** 3 + 1.70158 * (k - 1) ** 2;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

interface Ring {
  mesh: THREE.LineLoop;
  mat: THREE.ShaderMaterial;
  beadMat: THREE.ShaderMaterial;
  dir: number;
  speed: number;
}
interface Reticle {
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  speed: number;
  base: number;
}
interface Wave {
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  life: number;
  dur: number;
  r0: number;
  intensity: number;
}
interface Floater {
  obj: THREE.LineSegments;
  mat: THREE.ShaderMaterial;
  r: number;
  a: number;
  y: number;
  speed: number;
  spin: THREE.Vector3;
  ph: number;
}
interface Agent {
  path: THREE.ShaderMaterial;
  node: THREE.LineSegments;
  nodeMat: THREE.ShaderMaterial;
  on: number;
}

export class Core3D implements CoreRenderer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
  private root = new THREE.Group();
  private hud = new THREE.Group();
  private tier: Tier;
  private raf = 0;
  private running = false;
  private disposed = false;
  private last = 0;
  private params: CoreParams = { ...STATE_PARAMS.idle };
  private input: CoreInput = DEFAULT_INPUT;
  private prevState = DEFAULT_INPUT.state;
  private level = 0;
  private activity = 0;
  private pointer = { x: 0, y: 0 };
  private baseZ = 11;
  private phase = { core: 0, rings: 0, particles: 0, neural: 0, nodes: 0, paths: 0, pulse: 0, grid: 0, frag: 0, sweep: 0, gimbal: 0 };
  private bootT = BOOT_SECONDS + 1;
  private ignited = true;
  private waveClock = 0;
  private lastLevelWave = 0;
  private pixelRatio: number;
  private frameTimes: number[] = [];
  private slowWindows = 0;
  private disposables: { dispose(): void }[] = [];
  private shared = { uTime: { value: 0 }, uTint: { value: 0 }, uOk: { value: 0 }, uPR: { value: 1 } };

  private coreGroup = new THREE.Group();
  private coreMat!: THREE.ShaderMaterial;
  private nucleus!: THREE.Mesh;
  private nucleusMat!: THREE.ShaderMaterial;
  private gimbal = new THREE.Group();
  private gimbalRings: THREE.Object3D[] = [];
  private gimbalMat!: THREE.ShaderMaterial;
  private glow!: THREE.Mesh;
  private glowMat!: THREE.ShaderMaterial;
  private gridGroup = new THREE.Group();
  private gridMat!: THREE.ShaderMaterial;
  private scanDisc!: THREE.Mesh;
  private scanMat!: THREE.ShaderMaterial;
  private neuralMat!: THREE.ShaderMaterial;
  private nodeMat!: THREE.ShaderMaterial;
  private cages: { obj: THREE.LineSegments; mat: THREE.ShaderMaterial; axis: THREE.Vector3; speed: number }[] = [];
  private rings: Ring[] = [];
  private reticles: Reticle[] = [];
  private bezel!: THREE.Points;
  private bezelMat!: THREE.ShaderMaterial;
  private particleMat!: THREE.ShaderMaterial;
  private fragMat!: THREE.ShaderMaterial;
  private radarMat!: THREE.ShaderMaterial;
  private radar!: THREE.Mesh;
  private waves: Wave[] = [];
  private floaters: Floater[] = [];
  private agentGroup = new THREE.Group();
  private agents: Agent[] = [];
  private agentDisposables: { dispose(): void }[] = [];

  private composer: { render(): void; setSize(w: number, h: number): void; setPixelRatio(r: number): void; dispose(): void } | null = null;
  private bloomOn = false;

  constructor(
    private canvas: HTMLCanvasElement,
    private opts: Core3DOptions,
  ) {
    this.tier = TIERS[opts.quality];
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, powerPreference: 'high-performance', premultipliedAlpha: true });
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, this.tier.dpr);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setClearColor(0x000000, 0);
    this.shared.uPR.value = this.pixelRatio;
    this.camera.position.set(0, 0.4, this.baseZ);
    this.camera.lookAt(0, 0, 0);
    this.scene.add(this.root, this.hud, this.agentGroup);
    this.root.rotation.x = 0.18;
    this.agentGroup.rotation.x = 0.18;
    this.build();
    this.buildAgents(DEFAULT_INPUT.agentCount);
    canvas.addEventListener('webglcontextlost', this.onContextLost, false);
    if (this.tier.bloom) void this.initBloom();
    Object.assign(coreStats, { engine: '3d', quality: opts.quality, pixelRatio: this.pixelRatio, bloom: false, particles: this.tier.particles, fps: 0 });
  }

  private onContextLost = (e: Event) => {
    e.preventDefault();
    this.stop();
    this.opts.onTooSlow();
  };

  private track<T extends { dispose(): void }>(x: T, list = this.disposables): T {
    list.push(x);
    return x;
  }

  /** Additive, premultiplied shader material sharing time and state uniforms. */
  private mat(uniforms: Record<string, THREE.IUniform>, vertexShader: string, fragmentShader: string, list = this.disposables, extra: THREE.ShaderMaterialParameters = {}) {
    return this.track(
      new THREE.ShaderMaterial({
        uniforms: { ...this.shared, ...uniforms },
        vertexShader,
        fragmentShader,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        premultipliedAlpha: true,
        ...extra,
      }),
      list,
    );
  }

  /** Flat-colour line material (cages, gimbal, floating solids, agent nodes). */
  private lineMat(color: THREE.Color, alpha: number, list = this.disposables) {
    return this.mat(
      { uCol: { value: color.clone() }, uA: { value: alpha } },
      `void main(){ gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
      `${STATE_GLSL} uniform vec3 uCol; uniform float uA; void main(){ gl_FragColor = vec4(stateCol(uCol)*uA, uA); }`,
      list,
    );
  }

  private build() {
    const tier = this.tier;

    // --- core body: chromatic fresnel glass with noise displacement -------------------------
    this.root.add(this.coreGroup);
    this.coreMat = this.mat(
      { uDisp: { value: 0.04 }, uLevel: { value: 0 }, uColA: { value: C.cyan.clone() }, uColB: { value: C.violet.clone() }, uDeep: { value: C.deep.clone() }, uGlow: { value: 0.8 }, uViolet: { value: 0.2 }, uForm: { value: 1 } },
      `${NOISE}
        uniform float uTime; uniform float uDisp; uniform float uLevel;
        varying vec3 vNormal; varying vec3 vView; varying float vNoise; varying vec3 vPos;
        void main(){
          float n = snoise(position*1.5 + vec3(uTime*0.35));
          float n2 = snoise(position*3.6 - vec3(uTime*0.55));
          float d = (n*0.7 + n2*0.3) * (uDisp + uLevel*0.14);
          vec3 p = position + normal*d;
          vNoise = n; vPos = position;
          vec4 mv = modelViewMatrix*vec4(p,1.0);
          vView = -mv.xyz;
          vNormal = normalize(normalMatrix*normal);
          gl_Position = projectionMatrix*mv;
        }`,
      `${STATE_GLSL}
        uniform vec3 uColA; uniform vec3 uColB; uniform vec3 uDeep; uniform float uGlow; uniform float uViolet; uniform float uForm;
        varying vec3 vNormal; varying vec3 vView; varying float vNoise; varying vec3 vPos;
        void main(){
          vec3 n = normalize(vNormal); vec3 v = normalize(vView);
          float r = 1.0 - clamp(dot(n, v), 0.0, 1.0);
          vec3 fres = vec3(pow(r, 2.0), pow(r, 2.5), pow(r, 3.1));
          vec3 base = mix(uColA, uColB, clamp(uViolet*0.75 + vNoise*0.3, 0.0, 1.0));
          float bands = 0.5 + 0.5*sin(vNoise*16.0 + uTime*1.8);
          float striae = 0.5 + 0.5*sin(vPos.y*24.0 - uTime*2.0);
          vec3 L = normalize(vec3(-0.45, 0.55, 0.7));
          float spec = pow(max(dot(reflect(-v, n), L), 0.0), 28.0);
          vec3 col = uDeep*(0.22 + 0.3*bands) + base*(0.09 + 0.14*bands + 0.05*striae);
          col += vec3(base.r*fres.r + uColB.r*fres.r*0.4*uViolet, base.g*fres.g, base.b*fres.b) * 1.5;
          col += vec3(0.85, 0.97, 1.0) * spec * 0.5;
          col = stateCol(col);
          float a = (0.3 + fres.g*0.7) * uForm;
          gl_FragColor = vec4(col*uGlow*uForm, a*min(uGlow, 1.0));
        }`,
    );
    this.coreGroup.add(new THREE.Mesh(this.track(new THREE.IcosahedronGeometry(1.15, 4)), this.coreMat));

    // nucleus: hot centre that breathes and follows speech energy
    this.nucleusMat = this.mat(
      { uCol: { value: C.cyan.clone() }, uI: { value: 1 } },
      `varying vec3 vN; varying vec3 vV; void main(){ vec4 mv = modelViewMatrix*vec4(position,1.0); vV = -mv.xyz; vN = normalize(normalMatrix*normal); gl_Position = projectionMatrix*mv; }`,
      `${STATE_GLSL} uniform vec3 uCol; uniform float uI; varying vec3 vN; varying vec3 vV;
        void main(){ float ndv = clamp(dot(normalize(vN), normalize(vV)), 0.0, 1.0);
          vec3 col = mix(stateCol(uCol), vec3(1.0), pow(ndv, 2.0)*0.75) * (0.45 + 0.75*ndv) * uI;
          gl_FragColor = vec4(col, ndv*min(uI, 1.0)*0.9); }`,
    );
    this.nucleus = new THREE.Mesh(this.track(new THREE.IcosahedronGeometry(0.34, 3)), this.nucleusMat);
    this.coreGroup.add(this.nucleus);

    // tourbillon gimbal: two cages turning on different axes inside the core
    this.gimbalMat = this.lineMat(C.white, 0.5);
    for (const [r, tilt] of [[0.6, 0], [0.7, Math.PI / 2]] as const) {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i < 96; i++) {
        const a = (i / 96) * TAU;
        pts.push(new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, 0));
      }
      const loop = new THREE.LineLoop(this.track(new THREE.BufferGeometry().setFromPoints(pts)), this.gimbalMat);
      loop.rotation.y = tilt;
      const holder = new THREE.Group();
      holder.add(loop);
      this.gimbal.add(holder);
      this.gimbalRings.push(holder);
    }
    this.coreGroup.add(this.gimbal);

    // billboard glow with a chromatic halo (R, G, B rings slightly offset)
    this.glowMat = this.mat(
      { uCol: { value: C.cyan.clone() }, uGlow: { value: 0.8 }, uHalo: { value: 1.32 }, uForm: { value: 1 } },
      VERT_UV,
      `${STATE_GLSL} uniform vec3 uCol; uniform float uGlow; uniform float uHalo; uniform float uForm; varying vec2 vUv;
        void main(){
          float d = length(vUv-0.5)*9.0;
          float body = pow(max(1.0 - d/4.5, 0.0), 2.6)*0.4*uGlow;
          vec3 halo = vec3(exp(-pow((d-uHalo-0.03)/0.07, 2.0)), exp(-pow((d-uHalo)/0.07, 2.0)), exp(-pow((d-uHalo+0.03)/0.07, 2.0)));
          vec3 c = stateCol(uCol)*body + stateCol(vec3(0.7, 0.85, 1.0))*halo*0.22*uGlow;
          c *= uForm;
          gl_FragColor = vec4(c, (body + halo.g*0.1)*0.45*uForm);
        }`,
    );
    this.glow = new THREE.Mesh(this.track(new THREE.PlaneGeometry(9, 9)), this.glowMat);
    this.scene.add(this.glow);

    // --- wireframe grid sphere: lat/long lines, travelling grid pulses, scan beam ------------
    const GR = 1.42;
    const gpos: number[] = [];
    const gkind: number[] = [];
    const gu: number[] = [];
    const gid: number[] = [];
    const lats = [-70, -50, -30, -10, 10, 30, 50, 70];
    lats.forEach((deg, li) => {
      const phi = THREE.MathUtils.degToRad(deg);
      const n = 96;
      for (let i = 0; i < n; i++) {
        for (const k of [i, i + 1]) {
          const a = (k / n) * TAU;
          gpos.push(Math.cos(phi) * Math.cos(a) * GR, Math.sin(phi) * GR, Math.cos(phi) * Math.sin(a) * GR);
          gkind.push(0);
          gu.push(k / n);
          gid.push(li);
        }
      }
    });
    const meridians = 16;
    for (let m = 0; m < meridians; m++) {
      const th = (m / meridians) * TAU;
      const n = 48;
      for (let i = 0; i < n; i++) {
        for (const k of [i, i + 1]) {
          const phi = -Math.PI / 2 + (k / n) * Math.PI;
          gpos.push(Math.cos(phi) * Math.cos(th) * GR, Math.sin(phi) * GR, Math.cos(phi) * Math.sin(th) * GR);
          gkind.push(1);
          gu.push(k / n);
          gid.push(m);
        }
      }
    }
    const gridGeo = this.track(new THREE.BufferGeometry());
    gridGeo.setAttribute('position', new THREE.Float32BufferAttribute(gpos, 3));
    gridGeo.setAttribute('aKind', new THREE.Float32BufferAttribute(gkind, 1));
    gridGeo.setAttribute('aU', new THREE.Float32BufferAttribute(gu, 1));
    gridGeo.setAttribute('aId', new THREE.Float32BufferAttribute(gid, 1));
    this.gridMat = this.mat(
      { uGrid: { value: 0.35 }, uScan: { value: 0 }, uScanY: { value: 0 }, uFlow: { value: 0 }, uForm: { value: 1 }, uColA: { value: C.holo.clone() }, uColB: { value: C.cyan.clone() } },
      `attribute float aKind; attribute float aU; attribute float aId; varying float vKind; varying float vU; varying float vId; varying float vY; varying float vFace;
        void main(){ vKind = aKind; vU = aU; vId = aId; vY = position.y / ${GR.toFixed(2)};
          vFace = (normalMatrix*normalize(position)).z;
          gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
      `${STATE_GLSL} uniform float uGrid; uniform float uScan; uniform float uScanY; uniform float uFlow; uniform float uForm; uniform vec3 uColA; uniform vec3 uColB;
        varying float vKind; varying float vU; varying float vId; varying float vY; varying float vFace;
        void main(){
          float back = 0.3 + 0.7*smoothstep(-0.35, 0.45, vFace);
          float f = fract(vU - uFlow*0.35 + vId*0.371);
          float dash = vKind * smoothstep(0.0, 0.04, f) * smoothstep(0.2, 0.04, f);
          float rip = exp(-pow((vY - (fract(uFlow*0.12)*2.4 - 1.2))/0.13, 2.0));
          float scan = exp(-pow((vY - uScanY)/0.05, 2.0)) * uScan;
          float a = (0.08*uGrid + dash*0.45*uGrid + rip*0.22*uGrid + scan*0.85) * back * uForm;
          vec3 c = mix(uColA, uColB, clamp(dash + rip*0.6, 0.0, 1.0)) + vec3(0.6, 0.9, 1.0)*scan;
          gl_FragColor = vec4(stateCol(c)*a, a);
        }`,
    );
    this.gridGroup.add(new THREE.LineSegments(gridGeo, this.gridMat));
    // latitude scan beam: a translucent disc riding the scan line
    this.scanMat = this.mat(
      { uScan: { value: 0 }, uCol: { value: C.turq.clone() } },
      VERT_UV,
      `${STATE_GLSL} uniform float uScan; uniform vec3 uCol; varying vec2 vUv;
        void main(){ float d = length(vUv-0.5)*2.0; if (d > 1.0) discard;
          float a = (pow(d, 8.0)*0.7 + 0.04 + 0.05*step(0.5, fract(d*6.0 - uTime*2.0))*d) * uScan;
          gl_FragColor = vec4(stateCol(uCol)*a, a*0.6); }`,
      undefined,
      { side: THREE.DoubleSide },
    );
    this.scanDisc = new THREE.Mesh(this.track(new THREE.CircleGeometry(1, 64)), this.scanMat);
    this.scanDisc.rotation.x = -Math.PI / 2;
    this.gridGroup.add(this.scanDisc);
    this.root.add(this.gridGroup);

    // --- neural shell -------------------------------------------------------------------------
    const N = tier.neural;
    const pts: THREE.Vector3[] = [];
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < N; i++) {
      const y = 1 - (i / (N - 1)) * 2;
      const r = Math.sqrt(1 - y * y);
      const th = golden * i;
      const rad = 1.74 + (Math.random() - 0.5) * 0.18;
      pts.push(new THREE.Vector3(Math.cos(th) * r * rad, y * rad, Math.sin(th) * r * rad));
    }
    const segs: number[] = [];
    const tAttr: number[] = [];
    const phAttr: number[] = [];
    const seen = new Set<string>();
    pts.forEach((p, i) => {
      const near = pts
        .map((q, j) => ({ j, d: p.distanceToSquared(q) }))
        .filter((x) => x.j !== i)
        .sort((a, b) => a.d - b.d)
        .slice(0, 3);
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
    this.neuralMat = this.mat(
      { uPhase: { value: 0 }, uNeural: { value: 0.1 }, uCol: { value: C.ice.clone() }, uForm: { value: 1 } },
      `attribute float aT; attribute float aPhase; varying float vT; varying float vPh; void main(){ vT=aT; vPh=aPhase; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
      `${STATE_GLSL} uniform float uPhase; uniform float uNeural; uniform vec3 uCol; uniform float uForm; varying float vT; varying float vPh;
        void main(){ float head = fract(uPhase + vPh*7.0); float d = abs(vT-head);
          float pulse = smoothstep(0.22, 0.0, d)*uNeural*step(0.35, fract(vPh*13.0));
          float a = (0.035 + 0.06*uNeural + pulse*0.75)*uForm; gl_FragColor = vec4(stateCol(uCol)*a, a); }`,
    );
    this.root.add(new THREE.LineSegments(neuralGeo, this.neuralMat));

    const nodeGeo = this.track(new THREE.BufferGeometry().setFromPoints(pts));
    nodeGeo.setAttribute('aId', new THREE.Float32BufferAttribute(pts.map((_, i) => i), 1));
    this.nodeMat = this.mat(
      { uNodes: { value: 0.1 }, uTick: { value: 0 }, uCol: { value: C.cyan.clone() }, uForm: { value: 1 } },
      `attribute float aId; uniform float uNodes; uniform float uTick; uniform float uPR; varying float vOn;
        void main(){ float r = fract(sin(aId*12.9898 + floor(uTick)*78.233)*43758.5453); vOn = step(1.0 - uNodes*0.35, r);
          vec4 mv = modelViewMatrix*vec4(position,1.0); gl_PointSize = (2.0 + vOn*5.0)*uPR*(10.0/-mv.z); gl_Position = projectionMatrix*mv; }`,
      `${STATE_GLSL} uniform vec3 uCol; uniform float uForm; varying float vOn;
        void main(){ float d = length(gl_PointCoord-0.5); if(d>0.5) discard; float a = (0.25 + vOn*0.6)*(1.0-d*1.8)*uForm;
          gl_FragColor = vec4(stateCol(uCol)*a*(1.0+vOn), a); }`,
    );
    this.root.add(new THREE.Points(nodeGeo, this.nodeMat));

    // --- geometric cages -----------------------------------------------------------------------
    const cageDefs = [
      { geo: new THREE.OctahedronGeometry(1.52, 0), alpha: 0.14, axis: new THREE.Vector3(0.3, 1, 0.1), speed: 0.6, col: C.cyan },
      { geo: new THREE.DodecahedronGeometry(2.05, 0), alpha: 0.09, axis: new THREE.Vector3(-0.4, 1, 0.3), speed: -0.35, col: C.violet },
    ];
    for (const c of cageDefs) {
      const edges = this.track(new THREE.EdgesGeometry(c.geo));
      c.geo.dispose();
      const mat = this.lineMat(c.col, c.alpha);
      const obj = new THREE.LineSegments(edges, mat);
      this.root.add(obj);
      this.cages.push({ obj, mat, axis: c.axis.normalize(), speed: c.speed });
    }

    // --- tilted orbital rings with travelling energy beads -------------------------------------
    const ringDefs = [
      { r: 2.35, tilt: [1.2, 0.2, 0], dir: 1, speed: 1.0, dashes: 48, col: C.ice, beads: 3 },
      { r: 2.7, tilt: [0.4, -0.6, 0.3], dir: -1, speed: 0.7, dashes: 2, col: C.cyan, beads: 2 },
      { r: 3.05, tilt: [-0.9, 0.4, -0.2], dir: 1, speed: 0.5, dashes: 96, col: C.violet, beads: 3 },
      { r: 3.45, tilt: [1.45, 0, 0.6], dir: -1, speed: 0.35, dashes: 6, col: C.turq, beads: 2 },
    ];
    for (const d of ringDefs) {
      const n = 256;
      const pos: number[] = [];
      const ang: number[] = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU;
        pos.push(Math.cos(a) * d.r, 0, Math.sin(a) * d.r);
        ang.push(a);
      }
      const g = this.track(new THREE.BufferGeometry());
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('aA', new THREE.Float32BufferAttribute(ang, 1));
      const mat = this.mat(
        { uPhase: { value: 0 }, uDashes: { value: d.dashes }, uCol: { value: d.col.clone() }, uBright: { value: 0.7 }, uReveal: { value: 1 } },
        `attribute float aA; varying float vA; void main(){ vA=aA; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
        `${STATE_GLSL} uniform float uPhase; uniform float uDashes; uniform vec3 uCol; uniform float uBright; uniform float uReveal; varying float vA;
          void main(){ float u = vA/6.2831853; if (u > uReveal) discard;
            float f = fract(u*uDashes - uPhase);
            float on = uDashes < 4.0 ? smoothstep(0.0, 0.6, f)*0.9 : step(0.45, f);
            float head = (1.0 - step(0.999, uReveal)) * smoothstep(0.06, 0.0, uReveal - u) * 1.4;
            float a = (0.1 + on*0.42)*uBright + head;
            gl_FragColor = vec4(stateCol(uCol)*a, a); }`,
      );
      const mesh = new THREE.LineLoop(g, mat);
      mesh.rotation.set(d.tilt[0], d.tilt[1], d.tilt[2]);
      // beads: a bright head with a fading comet trail, positioned in the vertex shader
      const TRAIL = 10;
      const off: number[] = [];
      const trail: number[] = [];
      for (let b = 0; b < d.beads; b++) {
        for (let k = 0; k < TRAIL; k++) {
          off.push(b / d.beads - k * 0.0045 * d.dir);
          trail.push(k / TRAIL);
        }
      }
      const bg = this.track(new THREE.BufferGeometry());
      bg.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(off.length * 3), 3));
      bg.setAttribute('aOff', new THREE.Float32BufferAttribute(off, 1));
      bg.setAttribute('aTrail', new THREE.Float32BufferAttribute(trail, 1));
      bg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), d.r + 0.5);
      const beadMat = this.mat(
        { uPhase: { value: 0 }, uBeads: { value: 0.4 }, uR: { value: d.r }, uCol: { value: d.col.clone() }, uReveal: { value: 1 } },
        `attribute float aOff; attribute float aTrail; uniform float uPhase; uniform float uBeads; uniform float uR; uniform float uPR; uniform float uReveal; varying float vTrail;
          void main(){ float u = fract(aOff + uPhase); float a = u*6.2831853; vTrail = aTrail + step(uReveal, u)*2.0;
            vec4 mv = modelViewMatrix*vec4(cos(a)*uR, 0.0, sin(a)*uR, 1.0);
            gl_PointSize = (2.0 + 5.0*uBeads)*(1.0 - aTrail*0.75)*uPR*(10.0/-mv.z); gl_Position = projectionMatrix*mv; }`,
        `${STATE_GLSL} uniform float uBeads; uniform vec3 uCol; varying float vTrail;
          void main(){ if (vTrail > 1.0) discard; float d = length(gl_PointCoord-0.5); if(d>0.5) discard;
            float a = pow(1.0-vTrail, 1.6)*(1.0-d*2.0)*uBeads*1.1; vec3 c = mix(vec3(1.0), stateCol(uCol), 0.35 + vTrail*0.6);
            gl_FragColor = vec4(c*a, a); }`,
      );
      mesh.add(new THREE.Points(bg, beadMat));
      this.root.add(mesh);
      this.rings.push({ mesh, mat, beadMat, dir: d.dir, speed: d.speed });
    }

    // --- screen-plane holographic reticles (each turns independently) --------------------------
    const reticleDefs = [
      { r0: 1.94, r1: 1.97, seg: 3, duty: 0.16, speed: 0.55, col: C.ice, a: 0.55 },
      { r0: 3.6, r1: 3.62, seg: 1, duty: 0.07, speed: -0.42, col: C.turq, a: 0.75 },
      { r0: 3.7, r1: 3.77, seg: 4, duty: 0.19, speed: 0.06, col: C.cyan, a: 0.32 },
      { r0: 3.98, r1: 4.0, seg: 120, duty: 0.45, speed: -0.025, col: C.holo, a: 0.3 },
    ];
    for (const d of reticleDefs) {
      const mat = this.mat(
        { uSeg: { value: d.seg }, uDuty: { value: d.duty }, uCol: { value: d.col.clone() }, uA: { value: d.a }, uReveal: { value: 1 } },
        `varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
        `${STATE_GLSL} uniform float uSeg; uniform float uDuty; uniform vec3 uCol; uniform float uA; uniform float uReveal; varying vec2 vP;
          void main(){ float ang = atan(vP.y, vP.x)/6.2831853 + 0.5; float f = fract(ang*uSeg);
            float on = step(f, uDuty); float grad = on*(0.3 + 0.7*(f/uDuty));
            float a = grad*uA*uReveal; gl_FragColor = vec4(stateCol(uCol)*a, a); }`,
      );
      const mesh = new THREE.Mesh(this.track(new THREE.RingGeometry(d.r0, d.r1, 256, 1)), mat);
      mesh.rotation.z = Math.random() * TAU;
      this.hud.add(mesh);
      this.reticles.push({ mesh, mat, speed: d.speed, base: d.a });
    }
    // bezel ticks, watch-like
    const tick: THREE.Vector3[] = [];
    const big: number[] = [];
    for (let i = 0; i < 120; i++) {
      const a = (i / 120) * TAU;
      const r = i % 10 === 0 ? 3.86 : 3.9;
      tick.push(new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, 0));
      big.push(i % 10 === 0 ? 1 : 0);
    }
    const bezelGeo = this.track(new THREE.BufferGeometry().setFromPoints(tick));
    bezelGeo.setAttribute('aBig', new THREE.Float32BufferAttribute(big, 1));
    this.bezelMat = this.mat(
      { uCol: { value: C.ice.clone() }, uA: { value: 0.35 } },
      `attribute float aBig; uniform float uPR; varying float vBig; void main(){ vBig = aBig; vec4 mv = modelViewMatrix*vec4(position,1.0); gl_PointSize = (1.6 + aBig*1.6)*uPR*(10.0/-mv.z); gl_Position = projectionMatrix*mv; }`,
      `${STATE_GLSL} uniform vec3 uCol; uniform float uA; varying float vBig; void main(){ float d = length(gl_PointCoord-0.5); if(d>0.5) discard; float a = uA*(0.6 + vBig*0.6); gl_FragColor = vec4(stateCol(uCol)*a, a); }`,
    );
    this.bezel = new THREE.Points(bezelGeo, this.bezelMat);
    this.hud.add(this.bezel);

    // --- orbiting particles ----------------------------------------------------------------------
    const P = tier.particles;
    const seeds = new Float32Array(P * 4);
    for (let i = 0; i < P; i++) {
      seeds[i * 4] = 2.0 + Math.random() ** 0.7 * 2.7;
      seeds[i * 4 + 1] = Math.random() * TAU;
      seeds[i * 4 + 2] = (Math.random() - 0.5) * (0.25 + Math.random() * 0.9);
      seeds[i * 4 + 3] = 0.4 + Math.random();
    }
    const pg = this.track(new THREE.BufferGeometry());
    pg.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(P * 3), 3));
    pg.setAttribute('aSeed', new THREE.Float32BufferAttribute(seeds, 4));
    pg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 12);
    this.particleMat = this.mat(
      { uPhase: { value: 0 }, uTurb: { value: 0.05 }, uScale: { value: 1 }, uSpread: { value: 1 }, uAlpha: { value: 1 }, uColA: { value: C.cyan.clone() }, uColB: { value: C.ice.clone() }, uColC: { value: C.violet.clone() }, uViolet: { value: 0.2 } },
      `attribute vec4 aSeed; uniform float uPhase; uniform float uTime; uniform float uTurb; uniform float uScale; uniform float uSpread; uniform float uPR; varying float vMix; varying float vFade;
        void main(){
          float a = aSeed.y + uPhase*aSeed.w*(2.4/aSeed.x);
          float r = aSeed.x*mix(1.0, uScale, 0.6)*uSpread;
          float h = (aSeed.z + sin(uTime*0.8 + aSeed.y*5.0)*uTurb)*uSpread;
          vec3 p = vec3(cos(a)*r, h, sin(a)*r);
          float tilt = 0.35*sin(aSeed.y*3.0);
          p.yz = mat2(cos(tilt), -sin(tilt), sin(tilt), cos(tilt))*p.yz;
          vMix = fract(aSeed.w*7.0); vFade = 0.55 + 0.45*sin(uTime*2.0 + aSeed.y*11.0);
          vec4 mv = modelViewMatrix*vec4(p,1.0);
          gl_PointSize = (1.2 + vMix*1.7)*uPR*(10.0/-mv.z);
          gl_Position = projectionMatrix*mv;
        }`,
      `${STATE_GLSL} uniform vec3 uColA; uniform vec3 uColB; uniform vec3 uColC; uniform float uViolet; uniform float uAlpha; varying float vMix; varying float vFade;
        void main(){ float d = length(gl_PointCoord-0.5); if(d>0.5) discard;
          vec3 c = mix(mix(uColA, uColB, vMix), uColC, step(0.82 - uViolet*0.3, vMix));
          float a = (1.0-d*2.0)*0.55*vFade*uAlpha; gl_FragColor = vec4(stateCol(c)*a, a); }`,
    );
    this.root.add(new THREE.Points(pg, this.particleMat));

    // --- data fragments (instanced billboards, visible while researching) ----------------------
    const F = tier.fragments;
    const plane = this.track(new THREE.PlaneGeometry(1, 1));
    const fg = this.track(new THREE.InstancedBufferGeometry());
    fg.index = plane.index;
    fg.setAttribute('position', plane.getAttribute('position'));
    fg.setAttribute('uv', plane.getAttribute('uv'));
    const fseed = new Float32Array(F * 4);
    const fshape = new Float32Array(F * 3);
    for (let i = 0; i < F; i++) {
      fseed.set([2.3 + Math.random() * 1.7, Math.random() * TAU, (Math.random() - 0.5) * 1.6, (0.25 + Math.random() * 0.6) * (Math.random() < 0.5 ? -1 : 1)], i * 4);
      fshape.set([0.1 + Math.random() * 0.16, 0.035 + Math.random() * 0.04, Math.random()], i * 3);
    }
    fg.setAttribute('aSeed', new THREE.InstancedBufferAttribute(fseed, 4));
    fg.setAttribute('aShape', new THREE.InstancedBufferAttribute(fshape, 3));
    fg.instanceCount = F;
    this.fragMat = this.mat(
      { uPhase: { value: 0 }, uFrag: { value: 0 }, uColA: { value: C.turq.clone() }, uColB: { value: C.ice.clone() } },
      `attribute vec4 aSeed; attribute vec3 aShape; uniform float uPhase; uniform float uTime; uniform float uFrag; varying vec2 vUv; varying float vF;
        void main(){
          float a = aSeed.y + uPhase*aSeed.w;
          vec3 c = vec3(cos(a)*aSeed.x, aSeed.z + sin(uTime*0.6 + aSeed.y*3.0)*0.08, sin(a)*aSeed.x);
          vec4 mv = modelViewMatrix*vec4(c, 1.0);
          mv.xy += position.xy*aShape.xy*mix(0.3, 1.0, uFrag);
          vUv = uv; vF = fract(sin(aShape.z*91.7 + floor(uTime*5.0 + aShape.z*10.0))*4375.85);
          gl_Position = projectionMatrix*mv;
        }`,
      `${STATE_GLSL} uniform float uFrag; uniform vec3 uColA; uniform vec3 uColB; varying vec2 vUv; varying float vF;
        void main(){ vec2 q = abs(vUv-0.5)*2.0; float edge = step(0.8, max(q.x, q.y));
          float bars = step(0.5, fract(vUv.x*5.0 + vF*3.0))*step(q.y, 0.45);
          float a = (edge*0.75 + bars*0.4 + 0.08)*uFrag*(0.45 + 0.55*step(0.2, vF));
          gl_FragColor = vec4(stateCol(mix(uColA, uColB, vF))*a, a); }`,
    );
    const frags = new THREE.Mesh(fg, this.fragMat);
    frags.frustumCulled = false;
    this.root.add(frags);

    // --- radar sweep (equatorial disc, visible while researching) -----------------------------
    this.radarMat = this.mat(
      { uScan: { value: 0 }, uAng: { value: 0 }, uCol: { value: C.turq.clone() } },
      VERT_UV,
      `${STATE_GLSL} uniform float uScan; uniform float uAng; uniform vec3 uCol; varying vec2 vUv;
        float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7)))*43758.5453); }
        void main(){
          vec2 p = (vUv-0.5)*2.0; float d = length(p); if (d > 1.0) discard;
          float a = atan(p.y, p.x);
          float diff = mod(uAng - a, 6.2831853);
          float zone = smoothstep(0.3, 0.42, d);
          float trail = exp(-diff*2.4)*zone;
          float line = smoothstep(0.03, 0.0, diff)*zone;
          float rings = exp(-pow((d-0.5)/0.005, 2.0)) + exp(-pow((d-0.75)/0.005, 2.0)) + exp(-pow((d-0.985)/0.008, 2.0));
          vec2 cell = floor(p*8.0); vec2 cc = (cell + 0.5 + (vec2(hash(cell+1.3), hash(cell+7.1))-0.5)*0.6)/8.0;
          float blip = step(0.88, hash(cell))*smoothstep(0.035, 0.0, length(p-cc))*exp(-mod(uAng - atan(cc.y, cc.x), 6.2831853)*1.4)*step(0.42, length(cc));
          float alpha = (trail*0.22 + line*0.8 + rings*0.18*zone + blip*1.2)*uScan*(1.0 - smoothstep(0.92, 1.0, d)*0.5);
          gl_FragColor = vec4(stateCol(uCol)*alpha, alpha*0.7);
        }`,
      undefined,
      { side: THREE.DoubleSide },
    );
    this.radar = new THREE.Mesh(this.track(new THREE.PlaneGeometry(8.4, 8.4)), this.radarMat);
    this.radar.rotation.x = -Math.PI / 2;
    this.radar.position.y = -0.04;
    this.root.add(this.radar);

    // --- expanding energy / scanning waves (pool) ---------------------------------------------
    const waveGeo = this.track(new THREE.PlaneGeometry(2, 2));
    for (let i = 0; i < 6; i++) {
      const mat = this.mat(
        { uProg: { value: 0 }, uI: { value: 0 }, uCol: { value: C.cyan.clone() } },
        VERT_UV,
        `uniform float uProg; uniform float uI; uniform vec3 uCol; varying vec2 vUv;
          void main(){ float d = length(vUv-0.5)*2.0; float w = 0.012 + 0.04*uProg;
            vec3 ring = vec3(exp(-pow((d-uProg-0.006)/w, 2.0)), exp(-pow((d-uProg)/w, 2.0)), exp(-pow((d-uProg+0.006)/w, 2.0)));
            float inner = smoothstep(uProg, 0.0, d)*0.1*(1.0-uProg);
            float fade = pow(1.0-uProg, 1.4)*uI;
            vec3 c = (uCol*ring + uCol*inner)*fade;
            gl_FragColor = vec4(c, (ring.g*0.6 + inner)*fade*0.6); }`,
        undefined,
        { side: THREE.DoubleSide },
      );
      const mesh = new THREE.Mesh(waveGeo, mat);
      mesh.visible = false;
      this.scene.add(mesh);
      this.waves.push({ mesh, mat, life: 0, dur: 1, r0: 0.2, intensity: 0 });
    }

    // --- floating geometric solids --------------------------------------------------------------
    const shapes = [
      () => new THREE.TetrahedronGeometry(0.16, 0),
      () => new THREE.OctahedronGeometry(0.14, 0),
      () => new THREE.IcosahedronGeometry(0.13, 0),
      () => new THREE.BoxGeometry(0.18, 0.18, 0.18),
    ];
    for (let i = 0; i < tier.floaters; i++) {
      const geo = shapes[i % shapes.length]();
      const edges = this.track(new THREE.EdgesGeometry(geo));
      geo.dispose();
      const mat = this.lineMat(i % 3 === 0 ? C.violet : i % 3 === 1 ? C.cyan : C.ice, 0.3);
      const obj = new THREE.LineSegments(edges, mat);
      this.scene.add(obj);
      this.floaters.push({
        obj,
        mat,
        r: 4.3 + Math.random() * 1.2,
        a: (i / tier.floaters) * TAU + Math.random() * 0.4,
        y: (Math.random() - 0.5) * 3.2,
        speed: (0.02 + Math.random() * 0.04) * (i % 2 ? 1 : -1),
        spin: new THREE.Vector3(Math.random(), Math.random(), Math.random()).multiplyScalar(0.6),
        ph: Math.random() * TAU,
      });
    }
  }

  /** Pathways and nodes for each agent (rebuilt only if the roster size changes). */
  private buildAgents(n: number) {
    for (const d of this.agentDisposables) d.dispose();
    this.agentDisposables = [];
    this.agentGroup.clear();
    this.agents = [];
    const nodeGeo = this.track(new THREE.EdgesGeometry(new THREE.OctahedronGeometry(0.14, 0)), this.agentDisposables);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + Math.PI / n;
      const end = new THREE.Vector3(Math.cos(a) * 4.35, Math.sin(a * 2) * 0.45 + (i % 2 ? 0.35 : -0.35), Math.sin(a) * 4.35 * 0.6);
      const start = end.clone().normalize().multiplyScalar(1.25);
      const ctrl = start.clone().lerp(end, 0.5).add(new THREE.Vector3(0, 1.1 * (i % 2 ? 1 : -1), 0));
      const curve = new THREE.QuadraticBezierCurve3(start, ctrl, end);
      const cp = curve.getPoints(48);
      const g = this.track(new THREE.BufferGeometry().setFromPoints(cp), this.agentDisposables);
      g.setAttribute('aT', new THREE.Float32BufferAttribute(cp.map((_, k) => k / 48), 1));
      const col = i % 2 ? C.violet : C.cyan;
      const path = this.mat(
        { uPhase: { value: 0 }, uOn: { value: 0 }, uCol: { value: col.clone() }, uForm: { value: 1 } },
        `attribute float aT; varying float vT; void main(){ vT=aT; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
        `${STATE_GLSL} uniform float uPhase; uniform float uOn; uniform vec3 uCol; uniform float uForm; varying float vT;
          void main(){ float head = fract(uPhase); float p = smoothstep(0.14, 0.0, abs(vT-head)) + smoothstep(0.14, 0.0, abs(vT-fract(head+0.5)))*0.6;
            float a = (0.035 + uOn*(0.1 + p*0.85))*uForm; gl_FragColor = vec4(stateCol(uCol)*a, a); }`,
        this.agentDisposables,
      );
      this.agentGroup.add(new THREE.Line(g, path));
      const nodeMat = this.lineMat(col, 0.3, this.agentDisposables);
      const node = new THREE.LineSegments(nodeGeo, nodeMat);
      node.position.copy(end);
      this.agentGroup.add(node);
      this.agents.push({ path, node, nodeMat, on: 0 });
    }
  }

  private async initBloom() {
    try {
      const [{ EffectComposer }, { RenderPass }, { UnrealBloomPass }, { OutputPass }] = await Promise.all([
        import('three/addons/postprocessing/EffectComposer.js'),
        import('three/addons/postprocessing/RenderPass.js'),
        import('three/addons/postprocessing/UnrealBloomPass.js'),
        import('three/addons/postprocessing/OutputPass.js'),
      ]);
      if (this.disposed) return;
      const size = this.renderer.getSize(new THREE.Vector2());
      const target = new THREE.WebGLRenderTarget(Math.max(1, size.x), Math.max(1, size.y), { type: THREE.HalfFloatType, samples: 4 });
      const composer = new EffectComposer(this.renderer, target);
      composer.setPixelRatio(this.pixelRatio);
      composer.setSize(Math.max(1, size.x), Math.max(1, size.y));
      composer.addPass(new RenderPass(this.scene, this.camera));
      composer.addPass(new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.38, 0.4, 0.42));
      composer.addPass(new OutputPass());
      this.composer = composer;
      this.bloomOn = true;
      coreStats.bloom = true;
    } catch {
      this.composer = null; // bloom is an enhancement; the plain renderer continues
    }
  }

  update(input: CoreInput) {
    if (input.agentCount !== this.agents.length && input.agentCount > 0) this.buildAgents(input.agentCount);
    if (input.state !== this.prevState) this.onStateChange(this.prevState, input.state);
    this.prevState = input.state;
    this.input = input;
  }

  boot(play: boolean) {
    this.bootT = play && !this.input.reducedMotion ? 0 : BOOT_SECONDS + 1;
    this.ignited = !play;
  }

  pulse() {
    this.spawnWave(C.cyan, 'billboard', 0.9, 1.3, 4.2);
    this.spawnWave(C.ice, 'equator', 0.6, 1.8, 5);
  }

  resize(w: number, h: number) {
    if (w <= 0 || h <= 0) return;
    this.renderer.setSize(w, h, false);
    this.composer?.setSize(w, h);
    const aspect = w / h;
    this.camera.aspect = aspect;
    // Fit the outer reticle (radius ≈ 4) to the narrower dimension.
    const halfFov = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    this.baseZ = Math.max(10.2, Math.min(21, 4.15 / (halfFov * Math.min(1, aspect))));
    this.camera.updateProjectionMatrix();
  }

  start() {
    if (this.running || this.disposed) return;
    this.running = true;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  private onStateChange(from: CoreInput['state'], to: CoreInput['state']) {
    if (to === 'success') {
      // emerald energy expansion
      this.spawnWave(C.emerald, 'billboard', 1.2, 2.4, 6.2);
      this.spawnWave(C.emerald, 'equator', 1.0, 2.8, 6.5);
      setTimeout(() => this.spawnWave(C.turq, 'billboard', 0.7, 2.2, 5.4), 260);
    } else if (to === 'error') {
      this.spawnWave(C.red, 'billboard', 0.8, 2.6, 4.8);
    } else if (from === 'idle' && (to === 'thinking' || to === 'executing' || to === 'researching')) {
      this.spawnWave(to === 'thinking' ? C.violet : C.cyan, 'billboard', 0.8, 1.6, 4.4);
    }
  }

  private spawnWave(col: THREE.Color, kind: 'billboard' | 'equator', intensity: number, dur: number, maxR: number) {
    if (this.disposed) return;
    const w = this.waves.find((x) => !x.mesh.visible) ?? this.waves.reduce((a, b) => (a.life / a.dur > b.life / b.dur ? a : b));
    w.mesh.visible = true;
    w.life = 0;
    w.dur = dur;
    w.intensity = intensity;
    w.r0 = 1.25 / maxR;
    w.mesh.scale.setScalar(maxR);
    (w.mat.uniforms.uCol.value as THREE.Color).copy(col);
    if (kind === 'equator') {
      this.root.add(w.mesh);
      w.mesh.quaternion.identity();
      w.mesh.rotation.set(-Math.PI / 2, 0, 0);
    } else {
      this.scene.add(w.mesh);
    }
    w.mesh.userData.billboard = kind === 'billboard';
  }

  private frame = (now: number) => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.frame);
    const elapsed = now - this.last;
    if (this.tier.fpsCap && elapsed < 1000 / this.tier.fpsCap) return;
    const dt = Math.min(0.1, elapsed / 1000);
    this.last = now;
    this.measure(elapsed);
    this.step(dt, now / 1000);
    if (this.composer && this.bloomOn) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  };

  private step(dt: number, t: number) {
    const input = this.input;
    const motion = input.reducedMotion ? 0.35 : 1;
    this.params = lerpParams(this.params, STATE_PARAMS[input.state], 1 - Math.exp(-dt * 3.2));
    this.level += (input.level - this.level) * (1 - Math.exp(-dt * 10));
    this.activity += (input.activity - this.activity) * (1 - Math.exp(-dt * 1.5));
    this.pointer.x += (input.pointer.x - this.pointer.x) * (1 - Math.exp(-dt * 2.5));
    this.pointer.y += (input.pointer.y - this.pointer.y) * (1 - Math.exp(-dt * 2.5));
    const p = this.params;
    const act = this.activity;
    const ph = this.phase;
    ph.core += dt * p.spin * motion;
    ph.rings += dt * p.ringSpeed * (1 + act * 0.4) * motion;
    ph.particles += dt * p.particleSpeed * (1 + act * 0.6) * motion;
    ph.neural += dt * (0.25 + (p.neural + act * 0.25) * 0.9) * motion;
    ph.nodes += dt * (0.6 + p.nodes * 4) * motion;
    ph.paths += dt * (0.3 + p.pathways * 0.9) * motion;
    ph.pulse += dt * p.pulseRate * motion;
    ph.grid += dt * (0.25 + p.grid * 0.5 + p.scan * 0.4) * motion;
    ph.frag += dt * (0.12 + p.fragments * 0.25) * motion;
    ph.sweep += dt * (1.1 + p.scan * 0.9) * motion;
    ph.gimbal += dt * (0.5 + p.spin * 3 + this.level * 2) * motion;

    // boot sequence
    if (this.bootT <= BOOT_SECONDS) this.bootT += dt;
    const b = this.bootT;
    const B = {
      particles: stage(b, 0, 1.0),
      spread: 1 + (1 - stage(b, 0, 1.7)) * 1.5,
      core: clamp01((b - 0.5) / 1.0),
      grid: stage(b, 0.95, 0.8),
      neural: stage(b, 1.15, 0.9),
      hud: stage(b, 2.45, 0.7),
      nodes: stage(b, 2.65, 0.6),
    };
    if (!this.ignited && b >= 1.45) {
      this.ignited = true;
      this.spawnWave(C.white, 'billboard', 1.1, 1.8, 5.5);
      this.spawnWave(C.cyan, 'equator', 0.9, 2.4, 6);
    }
    const flash = Math.exp(-(((b - 1.45) * 4) ** 2)) * 0.9;

    this.shared.uTime.value = t * motion;
    this.shared.uTint.value = p.tint;
    this.shared.uOk.value = p.emerald;
    this.shared.uPR.value = this.pixelRatio;

    const breath = 0.5 + 0.5 * Math.sin(ph.pulse * TAU);
    const glow = (p.glow + this.level * 0.25 + act * 0.12) * (0.93 + 0.07 * breath) + flash;

    // camera parallax
    this.camera.position.set(this.pointer.x * 0.75, 0.4 + this.pointer.y * 0.5, this.baseZ);
    this.camera.lookAt(0, 0, 0);

    // core
    const formScale = B.core < 1 ? 0.12 + 0.88 * easeOutBack(B.core) : 1;
    this.coreGroup.scale.setScalar(formScale);
    const cu = this.coreMat.uniforms;
    cu.uDisp.value = p.displacement;
    cu.uLevel.value = this.level;
    cu.uGlow.value = glow;
    cu.uViolet.value = p.violet;
    cu.uForm.value = clamp01(B.core * 1.4);
    const pulse = 1 + Math.sin(ph.pulse * TAU) * 0.06 + this.level * 0.2;
    this.nucleus.scale.setScalar(pulse);
    this.nucleusMat.uniforms.uI.value = (0.8 + breath * 0.25 + this.level * 0.6 + flash * 1.5) * clamp01(B.core * 2);
    (this.nucleusMat.uniforms.uCol.value as THREE.Color).copy(C.cyan).lerp(C.violet, p.violet * 0.5);
    this.gimbalRings[0].rotation.x = ph.gimbal;
    this.gimbalRings[1].rotation.z = ph.gimbal * 0.7;
    this.gimbal.rotation.y = -ph.gimbal * 0.3;
    this.gimbalMat.uniforms.uA.value = (0.22 + p.spin * 0.6 + this.level * 0.3) * B.core;
    this.root.rotation.y = ph.core;

    this.glow.quaternion.copy(this.camera.quaternion);
    this.glowMat.uniforms.uGlow.value = glow * (0.85 + this.level * 0.4);
    this.glowMat.uniforms.uForm.value = B.core;
    this.glowMat.uniforms.uHalo.value = 1.3 * formScale + this.level * 0.12;
    (this.glowMat.uniforms.uCol.value as THREE.Color).copy(C.cyan).lerp(C.violet, p.violet * 0.4);

    // grid sphere (counter-rotates against the root for independent motion)
    this.gridGroup.rotation.y = -ph.core * 1.6;
    const gu = this.gridMat.uniforms;
    gu.uGrid.value = p.grid + act * 0.2;
    gu.uScan.value = p.scan;
    gu.uFlow.value = ph.grid;
    gu.uForm.value = B.grid;
    const scanY = Math.sin(t * 0.9 * motion) * 0.92;
    gu.uScanY.value = scanY;
    this.scanDisc.position.y = scanY * 1.42;
    this.scanDisc.scale.setScalar(Math.sqrt(Math.max(0, 1 - scanY * scanY)) * 1.42 * 1.01);
    this.scanDisc.visible = p.scan > 0.02;
    this.scanMat.uniforms.uScan.value = p.scan * B.grid;

    this.neuralMat.uniforms.uPhase.value = ph.neural;
    this.neuralMat.uniforms.uNeural.value = p.neural + act * 0.2;
    this.neuralMat.uniforms.uForm.value = B.neural;
    this.nodeMat.uniforms.uNodes.value = p.nodes;
    this.nodeMat.uniforms.uTick.value = ph.nodes;
    this.nodeMat.uniforms.uForm.value = B.neural;

    for (const c of this.cages) {
      c.obj.rotateOnAxis(c.axis, dt * c.speed * (0.4 + p.spin * 2) * motion);
      c.obj.scale.setScalar(0.6 + 0.4 * B.neural);
    }

    // rings: sequential activation during boot, beads ride them
    const ringScale = p.ringScale - this.level * 0.08;
    this.rings.forEach((r, i) => {
      const reveal = stage(b, 1.35 + i * 0.32, 0.6);
      r.mesh.visible = reveal > 0;
      r.mesh.rotateY(dt * r.speed * r.dir * p.ringSpeed * 1.4 * motion);
      const wobble = 1 + Math.sin(t * 6 + i) * this.level * 0.025;
      r.mesh.scale.setScalar(ringScale * wobble);
      r.mat.uniforms.uPhase.value = ph.rings * r.dir * (i + 1) * 0.6;
      r.mat.uniforms.uBright.value = 0.55 + p.glow * 0.35 + this.level * 0.4 + act * 0.15;
      r.mat.uniforms.uReveal.value = reveal;
      r.beadMat.uniforms.uPhase.value = ph.rings * r.dir * (0.18 + r.speed * 0.12);
      r.beadMat.uniforms.uBeads.value = Math.min(1.3, p.beads + act * 0.3);
      r.beadMat.uniforms.uReveal.value = reveal;
    });

    // reticles and bezel (screen plane)
    this.hud.quaternion.copy(this.camera.quaternion);
    const hudScale = 0.97 + 0.03 * B.hud + (ringScale - 1) * 0.15;
    this.hud.scale.setScalar(hudScale);
    this.reticles.forEach((r, i) => {
      r.mesh.rotation.z += dt * r.speed * (i === 0 ? 0.6 + p.spin * 3 : 1 + p.ringSpeed) * motion;
      r.mat.uniforms.uA.value = r.base * (0.8 + p.glow * 0.25 + (i === 1 ? p.scan * 0.6 : 0));
      r.mat.uniforms.uReveal.value = B.hud;
    });
    this.bezel.rotation.z = -ph.rings * 0.15;
    this.bezelMat.uniforms.uA.value = 0.3 * B.hud;

    // particles
    const pu = this.particleMat.uniforms;
    pu.uPhase.value = ph.particles;
    pu.uTurb.value = p.turbulence + this.level * 0.15;
    pu.uScale.value = ringScale;
    pu.uSpread.value = B.spread;
    pu.uAlpha.value = B.particles;
    pu.uViolet.value = p.violet;

    // research: fragments + radar sweep
    this.fragMat.uniforms.uPhase.value = ph.frag;
    this.fragMat.uniforms.uFrag.value = p.fragments;
    this.radar.visible = p.scan > 0.02;
    this.radarMat.uniforms.uScan.value = p.scan;
    this.radarMat.uniforms.uAng.value = ph.sweep;

    // waves
    const rate = (p.waves * 0.55 + act * 0.25) * (input.reducedMotion ? 0.3 : 1);
    if (b > BOOT_SECONDS) this.waveClock += dt * rate;
    if (this.waveClock >= 1) {
      this.waveClock = 0;
      const st = input.state;
      const col = st === 'thinking' ? (Math.random() < 0.5 ? C.violet : C.cyan) : st === 'researching' ? C.turq : st === 'success' ? C.emerald : st === 'error' ? C.red : st === 'speaking' ? C.ice : st === 'executing' ? C.cyan : C.holo;
      this.spawnWave(col, Math.random() < 0.35 ? 'equator' : 'billboard', 0.45 + p.waves * 0.35, 2.2 + (1 - p.waves) * 1.4, 4.6);
    }
    if (input.state === 'speaking' && this.level > 0.5 && t - this.lastLevelWave > 0.3) {
      this.lastLevelWave = t;
      this.spawnWave(C.ice, 'billboard', 0.35 + this.level * 0.4, 1.2, 3.6);
    }
    for (const w of this.waves) {
      if (!w.mesh.visible) continue;
      w.life += dt * (input.reducedMotion ? 0.6 : 1);
      const k = w.life / w.dur;
      if (k >= 1) {
        w.mesh.visible = false;
        continue;
      }
      w.mat.uniforms.uProg.value = w.r0 + (1 - w.r0) * (1 - (1 - k) ** 2.2);
      w.mat.uniforms.uI.value = w.intensity;
      if (w.mesh.userData.billboard) w.mesh.quaternion.copy(this.camera.quaternion);
    }

    // floating solids
    for (const f of this.floaters) {
      f.a += dt * f.speed * motion;
      f.obj.position.set(Math.cos(f.a) * f.r, f.y + Math.sin(t * 0.4 + f.ph) * 0.25, Math.sin(f.a) * f.r * 0.55 - 0.8);
      f.obj.rotation.x += dt * f.spin.x * motion;
      f.obj.rotation.y += dt * f.spin.y * motion;
      f.mat.uniforms.uA.value = (0.16 + act * 0.2 + p.glow * 0.08) * B.hud;
    }

    // agent pathways
    this.agentGroup.rotation.y = ph.core * 0.5;
    this.agents.forEach((a, i) => {
      const target = input.activeAgents.includes(i) ? 1 : p.pathways * 0.25;
      a.on += (target - a.on) * (1 - Math.exp(-dt * 4));
      a.path.uniforms.uOn.value = a.on;
      a.path.uniforms.uPhase.value = ph.paths + i * 0.17;
      a.path.uniforms.uForm.value = B.nodes;
      a.node.rotation.y += dt * (0.5 + a.on * 2) * motion;
      a.node.scale.setScalar((1 + a.on * 0.6 + Math.sin(t * 4 + i) * a.on * 0.15) * (0.3 + 0.7 * B.nodes));
      a.nodeMat.uniforms.uA.value = (0.22 + a.on * 0.65) * B.nodes;
    });
  }

  /** Adaptive quality: drop bloom, then resolution; persistent low FPS → host falls back to 2D. */
  private measure(elapsedMs: number) {
    if (document.hidden) return;
    this.frameTimes.push(elapsedMs);
    if (this.frameTimes.length < 90) return;
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    this.frameTimes = [];
    const fps = 1000 / avg;
    coreStats.fps = Math.round(fps);
    if (fps < this.tier.target) {
      if (this.bloomOn) {
        this.bloomOn = false;
        coreStats.bloom = false;
      } else if (this.pixelRatio > 0.75) {
        this.pixelRatio = Math.max(0.75, this.pixelRatio - 0.25);
        this.renderer.setPixelRatio(this.pixelRatio);
        const size = this.renderer.getSize(new THREE.Vector2());
        this.renderer.setSize(size.x, size.y, false);
        coreStats.pixelRatio = this.pixelRatio;
      } else if (fps < 24 && ++this.slowWindows >= 3) {
        this.stop();
        this.opts.onTooSlow();
      }
    } else this.slowWindows = 0;
  }

  dispose() {
    this.disposed = true;
    this.stop();
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    for (const d of this.agentDisposables) d.dispose();
    for (const d of this.disposables) d.dispose();
    this.composer?.dispose();
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
