import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { controller } from '../sim/controller';

const MARK_COLOR: Record<string, string> = { fault: '#f87171', security: '#e879f9', trust: '#a78bfa', safety: '#fb923c' };

/**
 * Time travel. Drag to any second of this run: the world is restored from an
 * exact snapshot and re-simulated to that tick. Inspect, then press play (the
 * future re-computes identically) or act (a new branch of history begins).
 */
export function Timeline() {
  useSyncExternalStore((cb) => controller.subscribe(cb), () => controller.version);
  const bar = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState(false);
  const [hover, setHover] = useState<{ x: number; t: number; text?: string } | null>(null);
  const pending = useRef<number | null>(null);
  const raf = useRef(0);

  const head = Math.max(1, controller.headT);
  const t = controller.sim.t;
  const live = controller.live;

  const tAt = (clientX: number) => {
    const r = bar.current!.getBoundingClientRect();
    return Math.round(Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * head);
  };
  // coalesce seeks to one per frame while dragging
  const requestSeek = (tt: number) => {
    pending.current = tt;
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      if (pending.current !== null) controller.seek(pending.current);
      pending.current = null;
    });
  };
  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => requestSeek(tAt(e.clientX));
    const up = () => setDrag(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  });

  const markers = controller.markers;
  return (
    <div className="timeline" data-tour="timeline">
      <button className="tl-btn" title="Back 10 s" onClick={() => controller.seek(t - 10)} disabled={t <= 0}>
        −10s
      </button>
      <div
        className={`tl-bar ${drag ? 'drag' : ''}`}
        ref={bar}
        onPointerDown={(e) => {
          setDrag(true);
          requestSeek(tAt(e.clientX));
        }}
        onPointerMove={(e) => {
          const r = bar.current!.getBoundingClientRect();
          const tt = tAt(e.clientX);
          const near = markers.find((m) => Math.abs(m.t - tt) <= Math.max(1, head / 120));
          setHover({ x: e.clientX - r.left, t: tt, text: near?.text });
        }}
        onPointerLeave={() => setHover(null)}
        role="slider"
        aria-label="Time travel"
        aria-valuemin={0}
        aria-valuemax={head}
        aria-valuenow={t}
      >
        <div className="tl-track" />
        <div className="tl-fill" style={{ width: `${(t / head) * 100}%` }} />
        {markers.map((m, i) => (
          <i key={i} className="tl-mark" style={{ left: `${(m.t / head) * 100}%`, background: MARK_COLOR[m.kind] ?? '#999' }} />
        ))}
        <div className="tl-knob" style={{ left: `${(t / head) * 100}%` }} />
        {hover && (
          <div className="tl-tip" style={{ left: hover.x }}>
            <b>t = {hover.t}s</b>
            {hover.text && <span>{hover.text}</span>}
          </div>
        )}
      </div>
      <button className="tl-btn" title="Forward 10 s" onClick={() => controller.seek(t + 10)} disabled={live}>
        +10s
      </button>
      {live ? (
        <span className="tl-live">
          <span className="dot" /> LIVE · {t}s
        </span>
      ) : (
        <button className="tl-live past" onClick={() => controller.seek(controller.headT)} title="Jump back to the present">
          ⟲ {t}s / {controller.headT}s · back to live
        </button>
      )}
    </div>
  );
}
