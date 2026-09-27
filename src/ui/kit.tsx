import katex from 'katex';
import { ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/* ------------------------------------------------------------ Help tooltip */
export function Help({ children, title }: { children: ReactNode; title?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const x = Math.min(window.innerWidth - 316, Math.max(8, r.left - 140));
    const y = r.bottom + 10 + 160 > window.innerHeight ? r.top - 10 : r.bottom + 10;
    setPos({ x, y: y });
  };
  return (
    <span
      ref={ref}
      className="help"
      tabIndex={0}
      aria-label={typeof title === 'string' ? title : 'help'}
      onMouseEnter={show}
      onMouseLeave={() => setPos(null)}
      onFocus={show}
      onBlur={() => setPos(null)}
    >
      ?
      {pos &&
        createPortal(
          <div className="tip" style={{ left: pos.x, top: pos.y, transform: pos.y < (ref.current?.getBoundingClientRect().top ?? 0) ? 'translateY(-100%)' : undefined }}>
            {title && <div style={{ fontWeight: 700, marginBottom: 4 }}>{title}</div>}
            {children}
          </div>,
          document.body,
        )}
    </span>
  );
}

/* ------------------------------------------------------------ Slider */
export function Slider(props: {
  label: string;
  help?: ReactNode;
  value: number;
  min: number;
  max: number;
  step?: number;
  format?: (v: number) => string;
  onChange: (v: number) => void;
  tourId?: string;
}) {
  const { label, help, value, min, max, step = 1, format, onChange } = props;
  const p = ((value - min) / (max - min)) * 100;
  return (
    <div className="ctl" data-tour={props.tourId}>
      <div className="ctl-head">
        <span>{label}</span>
        {help && <Help title={label}>{help}</Help>}
        <span className="val">{format ? format(value) : value}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        style={{ ['--p' as string]: `${p}%` }}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={label}
      />
    </div>
  );
}

/* ------------------------------------------------------------ Toggle */
export function Toggle({ label, on, onChange, help }: { label: string; on: boolean; onChange: (v: boolean) => void; help?: ReactNode }) {
  return (
    <div className="ctl-head" style={{ marginBottom: 6 }}>
      <label className={`toggle ${on ? 'on' : ''}`} onClick={() => onChange(!on)} role="switch" aria-checked={on}>
        <span className="sw" />
        {label}
      </label>
      {help && <Help title={label}>{help}</Help>}
    </div>
  );
}

/* ------------------------------------------------------------ Segmented */
export function Seg<T extends string | number>({ value, options, onChange }: { value: T; options: { v: T; label: ReactNode }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button key={String(o.v)} className={o.v === value ? 'on' : ''} onClick={() => onChange(o.v)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------ Accordion */
export function Section({ n, title, children, defaultOpen = true, right, tourId }: { n: string; title: string; children: ReactNode; defaultOpen?: boolean; right?: ReactNode; tourId?: string }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`acc ${open ? 'open' : ''}`} data-tour={tourId}>
      <button className="acc-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="num">{n}</span>
        {title}
        {right && <span style={{ marginLeft: 8 }} onClick={(e) => e.stopPropagation()}>{right}</span>}
        <svg className="chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && <div className="acc-body">{children}</div>}
    </div>
  );
}

/* ------------------------------------------------------------ Modal */
export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', k);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={wide ? { width: 'min(1240px, 100%)' } : undefined} role="dialog" aria-modal>
        <div className="modal-head">
          <div style={{ flex: 1 }}>{title}</div>
          <button className="btn icon" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal-body scroll-y">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------ Math */
export function TeX({ children, block }: { children: string; block?: boolean }) {
  const html = useMemo(() => katex.renderToString(children, { displayMode: !!block, throwOnError: false, strict: false }), [children, block]);
  return <span className={block ? 'tex-block' : 'tex'} dangerouslySetInnerHTML={{ __html: html }} />;
}

/* ------------------------------------------------------------ KPI */
export function Kpi({ k, v, s, help, color, tone }: { k: string; v: ReactNode; s?: ReactNode; help?: ReactNode; color?: string; tone?: 'lime' | 'mint' | 'coral' | 'silver' }) {
  return (
    <div className={`kpi ${tone ? `tone tone-${tone}` : ''}`}>
      <div className="k">
        {k}
        {help && <Help title={k}>{help}</Help>}
      </div>
      <div className="v" style={color ? { color } : undefined}>
        {v}
      </div>
      {s && <div className="s">{s}</div>}
    </div>
  );
}

/* ------------------------------------------------------------ Sparkline */
export function Sparkline({ data, color = '#c9f46b', height = 44, fill = true }: { data: number[]; color?: string; height?: number; fill?: boolean }) {
  const w = 240;
  if (data.length < 2) return <svg width="100%" height={height} />;
  const max = Math.max(1e-9, ...data);
  const min = Math.min(0, ...data);
  const pts = data.map((d, i) => [(i / (data.length - 1)) * w, height - 4 - ((d - min) / (max - min || 1)) * (height - 8)]);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
  return (
    <svg width="100%" height={height} viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none">
      {fill && <path d={`${line}L${w},${height}L0,${height}Z`} fill={color} opacity={0.12} />}
      <path d={line} fill="none" stroke={color} strokeWidth={1.8} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/* ------------------------------------------------------------ reveal on scroll */
export function useReveal<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (es) => es.forEach((e) => e.isIntersecting && e.target.classList.add('in')),
      { threshold: 0.12 },
    );
    el.querySelectorAll('.reveal').forEach((n) => io.observe(n));
    if (el.classList.contains('reveal')) io.observe(el);
    return () => io.disconnect();
  }, []);
  return ref;
}

/* ------------------------------------------------------------ icons */
export const Icon = {
  play: <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l13-7.5z" /></svg>,
  pause: <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4h4v16H6zM14 4h4v16h-4z" /></svg>,
  step: <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M5 4.5v15l10-7.5zM17 4h3v16h-3z" /></svg>,
  reset: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></svg>,
  arrow: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M5 12h14M13 6l6 6-6 6" /></svg>,
  down: <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 4v16M6 14l6 6 6-6" /></svg>,
  predict: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#141414" strokeWidth="1.8"><circle cx="12" cy="12" r="3" /><path d="M3 12c2.5-5 5.5-7 9-7s6.5 2 9 7c-2.5 5-5.5 7-9 7s-6.5-2-9-7z" /></svg>,
  cost: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#141414" strokeWidth="1.8"><path d="M4 19h16M7 16V9M12 16V5M17 16v-4" /></svg>,
  shield: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#141414" strokeWidth="1.8"><path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z" /><path d="m9 12 2 2 4-4" /></svg>,
  reserve: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#141414" strokeWidth="1.8"><rect x="3" y="4" width="18" height="17" rx="2" /><path d="M3 9h18M8 2v4M16 2v4" /></svg>,
  mesh: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#141414" strokeWidth="1.8"><circle cx="5" cy="6" r="2" /><circle cx="19" cy="6" r="2" /><circle cx="12" cy="18" r="2" /><path d="M7 6h10M6 8l5 8M18 8l-5 8" /></svg>,
  verify: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#141414" strokeWidth="1.8"><path d="M20 6 9 17l-5-5" /></svg>,
};

/* ------------------------------------------------------------ HoverSelect
 * Stylish dropdown: opens on hover (or click / keyboard), previews options live
 * while hovering them, commits on click, and reverts if you leave without choosing. */
export interface HoverOption<T> {
  v: T;
  label: ReactNode;
  hint?: ReactNode;
}
export function HoverSelect<T extends string | number>({
  label,
  icon,
  value,
  options,
  onChange,
  onPreview,
  tourId,
  align = 'left',
}: {
  label: string;
  icon?: ReactNode;
  value: T;
  options: HoverOption<T>[];
  onChange: (v: T) => void;
  onPreview?: (v: T) => void;
  tourId?: string;
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState<T | null>(null);
  const committed = useRef<T>(value);
  const closeTimer = useRef<number | undefined>(undefined);
  const previewing = useRef(false);
  if (!open) committed.current = value;

  const doOpen = () => {
    window.clearTimeout(closeTimer.current);
    if (!open) {
      committed.current = value;
      setOpen(true);
    }
  };
  const doClose = (revert: boolean) => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => {
      if (revert && previewing.current && onPreview) onPreview(committed.current);
      previewing.current = false;
      setHover(null);
      setOpen(false);
    }, revert ? 160 : 0);
  };
  const pick = (v: T) => {
    committed.current = v;
    previewing.current = false;
    onChange(v);
    doClose(false);
  };
  const current = options.find((o) => o.v === (hover ?? value)) ?? options.find((o) => o.v === value);
  return (
    <div
      className={`hsel ${open ? 'open' : ''}`}
      data-tour={tourId}
      onMouseEnter={doOpen}
      onMouseLeave={() => doClose(true)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') doClose(true);
      }}
    >
      <button className="hsel-trigger" onClick={() => (open ? doClose(true) : doOpen())} aria-haspopup="listbox" aria-expanded={open}>
        {icon && <span className="hsel-icon">{icon}</span>}
        <span className="hsel-text">
          <span className="hsel-label">{label}</span>
          <span className="hsel-value">{current?.label}</span>
        </span>
        <svg className="hsel-chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      <div className={`hsel-menu ${align}`} role="listbox">
        {options.map((o) => (
          <button
            key={String(o.v)}
            role="option"
            aria-selected={o.v === committed.current}
            className={`hsel-item ${o.v === committed.current ? 'sel' : ''} ${o.v === hover ? 'hov' : ''}`}
            onMouseEnter={() => {
              setHover(o.v);
              if (onPreview) {
                previewing.current = true;
                onPreview(o.v);
              }
            }}
            onFocus={() => setHover(o.v)}
            onClick={() => pick(o.v)}
          >
            <span className="hsel-item-main">
              <span>{o.label}</span>
              {o.hint && <span className="hsel-hint">{o.hint}</span>}
            </span>
            {o.v === committed.current && (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                <path d="M20 6 9 17l-5-5" />
              </svg>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
