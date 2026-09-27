import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { AmrModel } from './AmrModel';

/**
 * Scroll-driven AMR for the home page.
 *
 * The robot drives along a "floor tape" lane laid out in *document* coordinates:
 * straight runs down the page gutters, and horizontal crossings only inside the
 * empty gap bands between sections (elements marked data-lane="gap"). It therefore
 * never drives over text. Scrolling advances it along the lane; it steers into
 * corners, idles with a spinning lidar when you stop, and picks up a tote mid-page.
 */

type Pt = { x: number; y: number };
interface Lane {
  pts: Pt[];
  /** cumulative arc length (px) at each waypoint */
  len: number[];
  total: number;
  /** scroll mapping: virtual y (document y of the viewport focus line) -> arc length */
  map: { vy: number; u: number }[];
}

const ROBOT_PX = 80;
/** Scroll distance (px) over which the robot crosses from one gutter to the other. */
const CROSS_WINDOW = 320;
/** Viewport height fraction the robot tracks (its "focus line"). */
const FOCUS = 0.55;

function buildLane(): Lane | null {
  const content = document.querySelector('[data-lane-content]') as HTMLElement | null;
  if (!content) return null;
  const sy = window.scrollY;
  const r = content.getBoundingClientRect();
  if (r.left < ROBOT_PX + 24) return null; // no gutter: the robot hides rather than cover content
  const left = r.left / 2;
  const right = r.right + (window.innerWidth - r.right) / 2;
  const gaps = Array.from(document.querySelectorAll('[data-lane="gap"]')).map((g) => {
    const b = (g as HTMLElement).getBoundingClientRect();
    return b.top + sy + b.height / 2;
  });
  const start = document.querySelector('[data-lane="start"]') as HTMLElement | null;
  const startY = start ? start.getBoundingClientRect().top + sy : r.top + sy + 400;
  const endY = r.bottom + sy - 140;

  // Waypoints: down a gutter, across inside an empty gap band, down the other gutter…
  const pts: Pt[] = [{ x: right, y: startY }];
  const crossings: { y: number; i: number }[] = [];
  let x = right;
  for (const gy of gaps) {
    if (gy <= startY + 60 || gy >= endY - 60) continue;
    pts.push({ x, y: gy });
    crossings.push({ y: gy, i: pts.length - 1 });
    x = x === right ? left : right;
    pts.push({ x, y: gy });
  }
  pts.push({ x, y: endY });

  const len = [0];
  for (let i = 1; i < pts.length; i++) len.push(len[i - 1] + Math.abs(pts[i].x - pts[i - 1].x) + Math.abs(pts[i].y - pts[i - 1].y));
  const total = len[len.length - 1];

  // Scroll -> arc-length mapping. On vertical runs the robot keeps pace with the
  // focus line; each horizontal crossing is spread over CROSS_WINDOW px of scroll
  // centred on its gap, so the robot is on screen while it crosses.
  const map: { vy: number; u: number }[] = [{ vy: startY, u: 0 }];
  for (const c of crossings) {
    const lo = Math.max(map[map.length - 1].vy + 1, c.y - CROSS_WINDOW / 2);
    map.push({ vy: lo, u: len[c.i] });
    map.push({ vy: lo + CROSS_WINDOW, u: len[c.i + 1] });
  }
  map.push({ vy: Math.max(map[map.length - 1].vy + 1, endY), u: total });

  // The robot must reach the very end of the tape exactly when the page is fully
  // scrolled: the deepest focus line reachable is maxScroll + FOCUS·vh. Compress
  // the mapping into that range (never stretch it).
  const maxVy = Math.max(0, document.documentElement.scrollHeight - window.innerHeight) + FOCUS * window.innerHeight;
  const first = map[0].vy;
  const last = map[map.length - 1].vy;
  if (last > maxVy && maxVy > first) {
    const k = (maxVy - first) / (last - first);
    for (const m of map) m.vy = first + (m.vy - first) * k;
  }
  return { pts, len, total, map };
}

/** Point and heading on the polyline at arc length u (always exactly on the tape). */
function pointAt(l: Lane, u: number): { p: Pt; dir: Pt } {
  const uu = Math.max(0, Math.min(l.total, u));
  let i = 1;
  while (i < l.len.length - 1 && l.len[i] < uu) i++;
  const a = l.pts[i - 1];
  const b = l.pts[i];
  const seg = l.len[i] - l.len[i - 1] || 1;
  const k = (uu - l.len[i - 1]) / seg;
  return { p: { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k }, dir: { x: Math.sign(b.x - a.x), y: Math.sign(b.y - a.y) } };
}

function targetU(l: Lane, vy: number): number {
  const m = l.map;
  if (vy <= m[0].vy) return 0;
  for (let i = 1; i < m.length; i++) {
    if (vy <= m[i].vy) {
      const k = (vy - m[i - 1].vy) / (m[i].vy - m[i - 1].vy || 1);
      return m[i - 1].u + (m[i].u - m[i - 1].u) * k;
    }
  }
  return l.total;
}

function Driver({ laneRef }: { laneRef: React.MutableRefObject<Lane | null> }) {
  const g = useRef<THREE.Group>(null);
  const bodyRef = useRef<THREE.Group>(null);
  const trail = useRef<THREE.Mesh>(null);
  const { size } = useThree();
  const state = useRef({ u: -1, heading: 0, speed: 0, carrying: false, lane: null as Lane | null });
  const [carrying, setCarrying] = useState(false);

  useFrame((_, dt) => {
    const lane = laneRef.current;
    if (!lane || !g.current) {
      if (g.current) g.current.visible = false;
      return;
    }
    const s = state.current;
    const sy = window.scrollY;
    const vh = window.innerHeight;
    const atBottom = sy + vh >= document.documentElement.scrollHeight - 2;
    const want = atBottom ? lane.total : targetU(lane, sy + vh * FOCUS);
    if (s.u < 0 || s.lane !== lane) {
      // first frame or the layout changed: keep the same relative progress on the new lane
      s.u = s.lane && s.u >= 0 ? (s.u / s.lane.total) * lane.total : want;
      s.lane = lane;
    }
    // Drive along the tape (never off it): arc position chases the scroll target
    // with a speed limit, so the robot visibly drives through every corner.
    const du = want - s.u;
    const maxStep = Math.max(700, Math.abs(du) * 4) * dt;
    const step = Math.sign(du) * Math.min(Math.abs(du), maxStep);
    s.u += step;
    s.speed = s.speed * 0.85 + (Math.abs(step) / Math.max(dt, 1e-3)) * 0.15;

    const { p, dir } = pointAt(lane, s.u);
    // Face the direction of travel along the current segment (reverse when scrolling up).
    const sign = step < -0.01 ? -1 : 1;
    if (Math.abs(step) > 0.01) {
      const target = Math.atan2(dir.x * sign, dir.y * sign); // model faces +Z; screen y grows downward
      let d = target - s.heading;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      s.heading += d * Math.min(1, dt * 12);
    }
    const progress = s.u / lane.total;
    const nowCarry = progress > 0.3 && progress < 0.82;
    if (nowCarry !== s.carrying) {
      s.carrying = nowCarry;
      setCarrying(nowCarry);
    }
    // document -> viewport -> orthographic scene (origin at the canvas centre)
    const vy = p.y - sy;
    g.current.visible = vy > -ROBOT_PX && vy < vh + ROBOT_PX;
    g.current.position.set(p.x - size.width / 2, size.height / 2 - vy, 0);
    if (bodyRef.current) bodyRef.current.rotation.y = s.heading;
    if (trail.current) (trail.current.material as THREE.MeshBasicMaterial).opacity = 0.12 + Math.min(0.35, s.speed / 1500);
  });

  return (
    <group ref={g}>
      {/* soft glow puddle on the tape under the robot */}
      <mesh ref={trail} position={[0, 0, -60]}>
        <circleGeometry args={[ROBOT_PX * 0.62, 48]} />
        <meshBasicMaterial color="#c9f46b" transparent opacity={0.15} toneMapped={false} />
      </mesh>
      {/* tilt so we see top + front, a 3/4 view of the warehouse floor */}
      <group rotation={[0.62, 0, 0]} position={[0, -ROBOT_PX * 0.12, 0]}>
        <group ref={bodyRef} scale={ROBOT_PX}>
          <AmrModel accent="#c9f46b" status="#86e7a6" carrying={carrying} lidarSpeed={6} glow={1.1} />
        </group>
      </group>
    </group>
  );
}

export function ScrollRobot() {
  const laneRef = useRef<Lane | null>(null);
  const [path, setPath] = useState<string>('');
  const [docH, setDocH] = useState(0);
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const rebuild = () => {
      const lane = reduce ? null : buildLane();
      laneRef.current = lane;
      setEnabled(!!lane);
      setDocH(document.documentElement.scrollHeight);
      // the tape SVG lives inside the page container: convert document -> container coordinates
      const host = document.querySelector('.home') as HTMLElement | null;
      const hr = host?.getBoundingClientRect();
      const ox = hr ? hr.left : 0;
      const oy = hr ? hr.top + window.scrollY : 0;
      setPath(lane ? lane.pts.map((p, i) => `${i ? 'L' : 'M'}${(p.x - ox).toFixed(0)},${(p.y - oy).toFixed(0)}`).join('') : '');
    };
    rebuild();
    const ro = new ResizeObserver(rebuild);
    ro.observe(document.body);
    window.addEventListener('resize', rebuild);
    const t = setTimeout(rebuild, 800); // after fonts & 3D hero settle
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', rebuild);
      clearTimeout(t);
    };
  }, []);

  return (
    <>
      {/* floor tape in document space — sits under the content frames, visible in gutters & gaps */}
      {enabled && (
        <svg aria-hidden style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: docH, pointerEvents: 'none', zIndex: 0 }}>
          <path d={path} fill="none" stroke="rgba(201,244,107,0.22)" strokeWidth={10} strokeLinejoin="round" />
          <path d={path} fill="none" stroke="rgba(201,244,107,0.55)" strokeWidth={2} strokeDasharray="14 12" strokeLinejoin="round" />
        </svg>
      )}
      {enabled && (
        <div aria-hidden style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 4 }}>
          <Canvas style={{ pointerEvents: 'none' }} eventSource={undefined} orthographic camera={{ zoom: 1, position: [0, 0, 500], near: 0.1, far: 2000 }} dpr={[1, 2]} gl={{ alpha: true, antialias: true }}>
            <ambientLight intensity={0.7} />
            <directionalLight position={[200, 400, 600]} intensity={2.4} />
            <pointLight position={[0, 0, 300]} intensity={2} color="#86e7a6" distance={0} decay={0} />
            <Driver laneRef={laneRef} />
          </Canvas>
        </div>
      )}
    </>
  );
}
