import { useEffect, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';

export interface TourStep {
  target: string; // data-tour id
  title: string;
  body: string;
  before?: () => void;
}

/** Spotlight walkthrough: dims the page, cuts a hole around the target control and explains it. */
export function Tour({ steps, open, onClose }: { steps: TourStep[]; open: boolean; onClose: () => void }) {
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const step = steps[i];

  useEffect(() => {
    if (open) setI(0);
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !step) return;
    step.before?.();
    const find = () => {
      const el = document.querySelector(`[data-tour="${step.target}"]`) as HTMLElement | null;
      if (!el) return setRect(null);
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      setRect(el.getBoundingClientRect());
    };
    const t = setTimeout(find, 60);
    const t2 = setTimeout(find, 450);
    window.addEventListener('resize', find);
    window.addEventListener('scroll', find, true);
    return () => {
      clearTimeout(t);
      clearTimeout(t2);
      window.removeEventListener('resize', find);
      window.removeEventListener('scroll', find, true);
    };
  }, [open, i, step]);

  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight') setI((x) => Math.min(steps.length - 1, x + 1));
      if (e.key === 'ArrowLeft') setI((x) => Math.max(0, x - 1));
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [open, onClose, steps.length]);

  if (!open || !step) return null;
  const pad = 8;
  const r = rect ?? new DOMRect(window.innerWidth / 2 - 100, window.innerHeight / 2 - 40, 200, 80);
  const below = r.bottom + 230 < window.innerHeight;
  const left = Math.min(window.innerWidth - 380, Math.max(12, r.left));
  const top = below ? r.bottom + 16 : Math.max(12, r.top - 16 - 200);
  return createPortal(
    <div className="tour-root">
      <svg className="tour-mask" width="100%" height="100%">
        <defs>
          <mask id="tour-hole">
            <rect width="100%" height="100%" fill="white" />
            <rect x={r.left - pad} y={r.top - pad} width={r.width + pad * 2} height={r.height + pad * 2} rx={16} fill="black" />
          </mask>
        </defs>
        <rect width="100%" height="100%" fill="rgba(0,0,0,0.72)" mask="url(#tour-hole)" onClick={onClose} />
        <rect x={r.left - pad} y={r.top - pad} width={r.width + pad * 2} height={r.height + pad * 2} rx={16} fill="none" stroke="#c9f46b" strokeWidth={2} className="tour-glow" />
      </svg>
      <div className="tour-card" style={{ left, top }}>
        <div className="eyebrow">
          Step {i + 1} of {steps.length}
        </div>
        <div className="h3" style={{ margin: '6px 0 8px', fontSize: 19 }}>
          {step.title}
        </div>
        <p style={{ margin: 0, color: 'var(--text-2)', fontSize: 14 }}>{step.body}</p>
        <div className="tour-dots">
          {steps.map((_, k) => (
            <span key={k} className={k === i ? 'on' : ''} onClick={() => setI(k)} />
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <button className="btn sm ghost" onClick={onClose}>
            Skip tour
          </button>
          <span style={{ flex: 1 }} />
          <button className="btn sm" disabled={i === 0} onClick={() => setI(i - 1)}>
            Back
          </button>
          {i < steps.length - 1 ? (
            <button className="btn sm lime" onClick={() => setI(i + 1)}>
              Next
            </button>
          ) : (
            <button className="btn sm lime" onClick={onClose}>
              Start exploring
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
