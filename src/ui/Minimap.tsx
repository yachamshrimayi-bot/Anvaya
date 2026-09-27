import { useEffect, useRef } from 'react';
import { CellKind } from '../engine/types';
import { controller, ROBOT_COLORS } from '../sim/controller';

/** Live 2D warehouse minimap (like the previous prototype), drawn every animation frame. */
export function Minimap() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const cv = ref.current;
      const sim = controller.sim;
      if (!cv || !sim) return;
      const ctx = cv.getContext('2d');
      if (!ctx) return;
      const W = sim.map.width;
      const H = sim.map.height;
      const s = Math.floor(Math.min(cv.width / W, cv.height / H));
      const ox = Math.floor((cv.width - s * W) / 2);
      const oy = Math.floor((cv.height - s * H) / 2);
      ctx.fillStyle = '#0c0e0e';
      ctx.fillRect(0, 0, cv.width, cv.height);
      for (let c = 0; c < sim.map.n; c++) {
        const k = sim.map.kind[c];
        const x = ox + sim.map.x(c) * s;
        const y = oy + sim.map.y(c) * s;
        ctx.fillStyle = k === CellKind.Rack ? '#d9826a' : k === CellKind.Drop ? '#2dd4bf' : k === CellKind.Charger ? '#facc15' : '#1f2422';
        ctx.fillRect(x, y, s - 1, s - 1);
      }
      ctx.fillStyle = 'rgba(167,139,250,0.35)';
      for (const z of sim.net.deadZones) ctx.fillRect(ox + z.x * s, oy + z.y * s, z.w * s, z.h * s);
      ctx.fillStyle = '#f59e0b';
      for (const c of sim.blocked) ctx.fillRect(ox + sim.map.x(c) * s + 1, oy + sim.map.y(c) * s + 1, s - 3, s - 3);
      sim.robots.forEach((r, i) => {
        const x = ox + sim.map.x(r.pos) * s + s / 2;
        const y = oy + sim.map.y(r.pos) * s + s / 2;
        ctx.beginPath();
        ctx.arc(x, y, Math.max(2.5, s * 0.42), 0, Math.PI * 2);
        ctx.fillStyle = ROBOT_COLORS[i % ROBOT_COLORS.length];
        ctx.fill();
        if (controller.selected === i) {
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      });
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);
  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const cv = ref.current!;
    const sim = controller.sim;
    const r = cv.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * cv.width;
    const py = ((e.clientY - r.top) / r.height) * cv.height;
    const s = Math.floor(Math.min(cv.width / sim.map.width, cv.height / sim.map.height));
    const ox = Math.floor((cv.width - s * sim.map.width) / 2);
    const oy = Math.floor((cv.height - s * sim.map.height) / 2);
    let best = -1;
    let bd = 1e9;
    sim.robots.forEach((rb, i) => {
      const d = Math.hypot(ox + sim.map.x(rb.pos) * s + s / 2 - px, oy + sim.map.y(rb.pos) * s + s / 2 - py);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    controller.selected = bd < s * 2 ? best : -1;
    controller.notify();
  };
  return (
    <div className="minimap">
      <div className="minimap-title">Warehouse minimap</div>
      <canvas ref={ref} width={200} height={200} onClick={onClick} />
    </div>
  );
}
