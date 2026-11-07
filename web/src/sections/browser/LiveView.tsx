import { useEffect, useRef, useState } from 'react';
import { Icon } from '../../components/icons';

/**
 * Streams a real Chromium tab running on the server. Frames arrive as JPEG
 * over a WebSocket; taps, scrolls and typing are sent back. Coordinates are
 * mapped from the displayed image to the remote viewport.
 */
export function LiveView({ tabId, onState, onError }: { tabId: string; onState: (s: { url: string; title: string; loading: boolean }) => void; onError: (m: string) => void }) {
  const wrap = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const kbd = useRef<HTMLInputElement>(null);
  const ws = useRef<WebSocket | null>(null);
  const viewport = useRef({ width: 1024, height: 700 });
  const [connected, setConnected] = useState(false);
  const [frames, setFrames] = useState(0);

  useEffect(() => {
    let closed = false;
    let lastUrl: string | null = null;
    let retry = 0;
    const open = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const sock = new WebSocket(`${proto}://${location.host}/api/browser/live/ws/${tabId}`);
      sock.binaryType = 'blob';
      ws.current = sock;
      sock.onopen = () => {
        retry = 0;
        setConnected(true);
        sendViewport();
      };
      sock.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
          const m = JSON.parse(ev.data);
          if (m.type === 'state') onState({ url: m.url, title: m.title, loading: m.loading });
          if (m.type === 'error') onError(m.message);
          return;
        }
        const url = URL.createObjectURL(ev.data as Blob);
        if (img.current) img.current.src = url;
        if (lastUrl) URL.revokeObjectURL(lastUrl);
        lastUrl = url;
        setFrames((f) => f + 1);
      };
      sock.onclose = (ev) => {
        setConnected(false);
        if (closed || ev.code === 4404 || ev.code === 4401) {
          if (ev.code === 4404) onError('This remote tab no longer exists (closed after being idle). Reopen the page.');
          return;
        }
        setTimeout(open, Math.min(8000, 600 * 2 ** retry++));
      };
    };
    open();
    const ro = new ResizeObserver(() => sendViewport());
    if (wrap.current) ro.observe(wrap.current);
    return () => {
      closed = true;
      ro.disconnect();
      ws.current?.close();
      if (lastUrl) URL.revokeObjectURL(lastUrl);
    };
  }, [tabId]);

  const send = (msg: unknown) => {
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify(msg));
  };
  const sendViewport = () => {
    const r = wrap.current?.getBoundingClientRect();
    if (!r || r.width < 50) return;
    const width = Math.round(Math.min(1600, Math.max(320, r.width)));
    const height = Math.round(Math.min(1600, Math.max(320, r.height)));
    viewport.current = { width, height };
    send({ type: 'viewport', width, height });
  };
  const map = (clientX: number, clientY: number) => {
    const r = img.current!.getBoundingClientRect();
    return { x: ((clientX - r.left) / r.width) * viewport.current.width, y: ((clientY - r.top) / r.height) * viewport.current.height };
  };

  // Gesture handling: short press = tap, drag = scroll (natural direction).
  const gesture = useRef<{ x: number; y: number; t: number; lastX: number; lastY: number; moved: boolean } | null>(null);
  const pending = useRef({ dx: 0, dy: 0, x: 0, y: 0, raf: 0 });
  const onPointerDown = (e: React.PointerEvent) => {
    gesture.current = { x: e.clientX, y: e.clientY, t: Date.now(), lastX: e.clientX, lastY: e.clientY, moved: false };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g) return;
    if (Math.hypot(e.clientX - g.x, e.clientY - g.y) > 8) g.moved = true;
    if (!g.moved) return;
    const scale = viewport.current.width / (img.current?.getBoundingClientRect().width || viewport.current.width);
    pending.current.dx += -(e.clientX - g.lastX) * scale;
    pending.current.dy += -(e.clientY - g.lastY) * scale;
    const p = map(e.clientX, e.clientY);
    pending.current.x = p.x;
    pending.current.y = p.y;
    g.lastX = e.clientX;
    g.lastY = e.clientY;
    if (!pending.current.raf) {
      pending.current.raf = requestAnimationFrame(() => {
        send({ type: 'scroll', dx: pending.current.dx, dy: pending.current.dy, x: pending.current.x, y: pending.current.y });
        pending.current.dx = 0;
        pending.current.dy = 0;
        pending.current.raf = 0;
      });
    }
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const g = gesture.current;
    gesture.current = null;
    if (!g || g.moved || Date.now() - g.t > 600 || !img.current) return;
    const p = map(e.clientX, e.clientY);
    send({ type: 'tap', ...p });
  };
  const onWheel = (e: React.WheelEvent) => {
    const p = map(e.clientX, e.clientY);
    send({ type: 'scroll', dx: e.deltaX, dy: e.deltaY, ...p });
  };

  return (
    <div className="live-frame" ref={wrap} data-testid="live-view">
      <img ref={img} alt="Remote browser" draggable={false} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={() => (gesture.current = null)} onWheel={onWheel} />
      {!connected && <div className="empty" style={{ position: 'absolute', top: 40 }}>Connecting to the remote browser…</div>}
      {connected && frames === 0 && <div className="empty" style={{ position: 'absolute', top: 40 }}>Waiting for the first frame…</div>}
      <input
        ref={kbd}
        className="live-kbd"
        autoCapitalize="off"
        autoCorrect="off"
        onInput={(e) => {
          const v = (e.target as HTMLInputElement).value;
          if (v) send({ type: 'text', text: v });
          (e.target as HTMLInputElement).value = '';
        }}
        onKeyDown={(e) => {
          if (['Enter', 'Backspace', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
            e.preventDefault();
            send({ type: 'key', key: e.key });
          }
        }}
        aria-label="Type into the remote page"
      />
      <button className="btn sm" style={{ position: 'absolute', right: 12, bottom: 12, opacity: 0.9 }} onClick={() => kbd.current?.focus()} aria-label="Show keyboard for the remote page">
        <Icon name="keyboard" size={18} /> Keyboard
      </button>
    </div>
  );
}
