import type React from 'react';
import { OrbitControls } from '@react-three/drei';
import { Canvas, ThreeEvent, useFrame, useThree } from '@react-three/fiber';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import type { OrbitControls as OrbitImpl } from 'three-stdlib';
import { AnvayaAgent } from '../engine/anvaya';
import type { Simulation } from '../engine/sim';
import { CellKind } from '../engine/types';
import { controller, ROBOT_COLORS } from '../sim/controller';
import { AmrModel } from './AmrModel';

export const ACTION_COLOR: Record<string, string> = {
  GO: '#a3e635',
  REROUTE: '#22d3ee',
  YIELD: '#fbbf24',
  HOLD: '#fb923c',
  WAIT: '#94a3b8',
  SERVICE: '#2dd4bf',
  STOPPED: '#f87171',
};
const PRIO_COLOR: Record<string, string> = { LOW: '#cbd5e1', NORMAL: '#38bdf8', HIGH: '#fbbf24', URGENT: '#fb7185' };

type Getter = () => Simulation | null;

const cellToWorld = (sim: Simulation, c: number, y = 0): [number, number, number] => [
  sim.map.x(c) - sim.map.width / 2 + 0.5,
  y,
  sim.map.y(c) - sim.map.height / 2 + 0.5,
];

/* =============================================================== static world
 * Lit industrial floor, orange pallet racking with blue totes, packing stations,
 * chargers and home bays — built once per warehouse (instanced meshes). */
function Warehouse({ sim }: { sim: Simulation }) {
  const W = sim.map.width;
  const H = sim.map.height;
  const racks = useMemo(() => {
    const out: number[] = [];
    for (let c = 0; c < sim.map.n; c++) if (sim.map.kind[c] === CellKind.Rack) out.push(c);
    return out;
  }, [sim]);
  const postRef = useRef<THREE.InstancedMesh>(null);
  const deckRef = useRef<THREE.InstancedMesh>(null);
  const toteRef = useRef<THREE.InstancedMesh>(null);

  useEffect(() => {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    const col = new THREE.Color();
    let pi = 0;
    let di = 0;
    let ti = 0;
    const toteColors = ['#5eead4', '#c9f46b', '#e5e7eb', '#f9a8d4', '#86efac', '#fdba74'];
    for (const c of racks) {
      const [x, , z] = cellToWorld(sim, c);
      for (const [ox, oz] of [[-0.38, -0.38], [0.38, -0.38], [-0.38, 0.38], [0.38, 0.38]]) {
        m.compose(p.set(x + ox, 0.5, z + oz), q, s.set(0.07, 1.0, 0.07));
        postRef.current?.setMatrixAt(pi++, m);
      }
      for (let k = 0; k < 2; k++) {
        m.compose(p.set(x, 0.1 + k * 0.5, z), q, s.set(0.84, 0.06, 0.84));
        deckRef.current?.setMatrixAt(di++, m);
        const h = (c * 2654435761 + k * 97) >>> 0;
        if (h % 4 !== 0) {
          m.compose(p.set(x + ((h % 5) - 2) * 0.03, 0.27 + k * 0.5, z), q, s.set(0.56, 0.28, 0.56));
          toteRef.current?.setMatrixAt(ti, m);
          col.set(toteColors[h % toteColors.length]);
          toteRef.current?.setColorAt(ti, col);
          ti++;
        }
      }
    }
    for (const r of [postRef, deckRef, toteRef]) if (r.current) r.current.instanceMatrix.needsUpdate = true;
    if (toteRef.current) {
      toteRef.current.count = ti;
      if (toteRef.current.instanceColor) toteRef.current.instanceColor.needsUpdate = true;
    }
  }, [racks, sim]);

  const gridGeo = useMemo(() => {
    const pts: number[] = [];
    for (let x = 0; x <= W; x++) pts.push(x - W / 2, 0.004, -H / 2, x - W / 2, 0.004, H / 2);
    for (let y = 0; y <= H; y++) pts.push(-W / 2, 0.004, y - H / 2, W / 2, 0.004, y - H / 2);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    return g;
  }, [W, H]);

  const borderGeo = useMemo(() => {
    const e = 0.35;
    const pts = [-W / 2 - e, 0.01, -H / 2 - e, W / 2 + e, 0.01, -H / 2 - e, W / 2 + e, 0.01, -H / 2 - e, W / 2 + e, 0.01, H / 2 + e, W / 2 + e, 0.01, H / 2 + e, -W / 2 - e, 0.01, H / 2 + e, -W / 2 - e, 0.01, H / 2 + e, -W / 2 - e, 0.01, -H / 2 - e];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    return g;
  }, [W, H]);

  const stations = useMemo(() => {
    const out: { c: number; kind: CellKind }[] = [];
    for (const c of sim.map.drops) out.push({ c, kind: CellKind.Drop });
    for (const c of sim.map.chargers) out.push({ c, kind: CellKind.Charger });
    for (const c of sim.map.homes) out.push({ c, kind: CellKind.Home });
    return out;
  }, [sim]);

  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[W + 1.4, H + 1.4]} />
        <meshStandardMaterial color="#1a1e1f" roughness={0.9} metalness={0.08} />
      </mesh>
      <lineSegments geometry={gridGeo}>
        <lineBasicMaterial color="#2f3a2c" />
      </lineSegments>
      <lineSegments geometry={borderGeo}>
        <lineBasicMaterial color="#c9f46b" />
      </lineSegments>
      <instancedMesh ref={postRef} args={[undefined, undefined, Math.max(1, racks.length * 4)]} castShadow>
        <boxGeometry />
        <meshStandardMaterial color="#b8c0ca" metalness={0.7} roughness={0.3} />
      </instancedMesh>
      <instancedMesh ref={deckRef} args={[undefined, undefined, Math.max(1, racks.length * 3)]} castShadow receiveShadow>
        <boxGeometry />
        <meshStandardMaterial color="#f59a74" metalness={0.2} roughness={0.5} />
      </instancedMesh>
      <instancedMesh ref={toteRef} args={[undefined, undefined, Math.max(1, racks.length * 3)]} castShadow>
        <boxGeometry />
        <meshStandardMaterial roughness={0.55} metalness={0.05} />
      </instancedMesh>
      {stations.map(({ c, kind }) => {
        const [x, , z] = cellToWorld(sim, c);
        const color = kind === CellKind.Drop ? '#2dd4bf' : kind === CellKind.Charger ? '#facc15' : '#64748b';
        return (
          <group key={`${kind}-${c}`} position={[x, 0.012, z]}>
            <mesh rotation={[-Math.PI / 2, 0, 0]}>
              <planeGeometry args={[0.92, 0.92]} />
              <meshBasicMaterial color={color} transparent opacity={kind === CellKind.Home ? 0.18 : 0.35} toneMapped={false} />
            </mesh>
            {kind === CellKind.Drop && (
              <mesh position={[-0.4, 0.4, 0]} castShadow>
                <boxGeometry args={[0.14, 0.8, 0.94]} />
                <meshStandardMaterial color="#115e59" emissive="#2dd4bf" emissiveIntensity={0.35} />
              </mesh>
            )}
            {kind === CellKind.Charger && (
              <mesh position={[0.4, 0.3, 0]} castShadow>
                <boxGeometry args={[0.14, 0.6, 0.55]} />
                <meshStandardMaterial color="#713f12" emissive="#facc15" emissiveIntensity={0.6} />
              </mesh>
            )}
          </group>
        );
      })}
    </group>
  );
}

/* =============================================================== dead zones (changes rarely) */
function DeadZones({ get }: { get: Getter }) {
  const [, force] = useState(0);
  const last = useRef('');
  useEffect(
    () =>
      controller.subscribe(() => {
        const s = get();
        const key = s ? JSON.stringify(s.net.deadZones) : '';
        if (key !== last.current) {
          last.current = key;
          force((x) => x + 1);
        }
      }),
    [get],
  );
  const sim = get();
  if (!sim) return null;
  const W = sim.map.width;
  const H = sim.map.height;
  return (
    <group>
      {sim.net.deadZones.map((r, i) => (
        <mesh key={i} position={[r.x + r.w / 2 - W / 2, 0.03, r.y + r.h / 2 - H / 2]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[r.w, r.h]} />
          <meshBasicMaterial color="#a78bfa" transparent opacity={0.28} toneMapped={false} depthWrite={false} />
        </mesh>
      ))}
    </group>
  );
}

/* =============================================================== dynamic layer (per frame, no React re-renders) */
function Dynamic({ get, sim }: { get: Getter; sim: Simulation }) {
  const zoneRef = useRef<THREE.InstancedMesh>(null);
  const ribbonRef = useRef<THREE.InstancedMesh>(null);
  const heatRef = useRef<THREE.InstancedMesh>(null);
  const palletRef = useRef<THREE.InstancedMesh>(null);
  const taskRef = useRef<THREE.InstancedMesh>(null);
  const packetsRef = useRef<THREE.LineSegments>(null);
  const linesRef = useRef<THREE.LineSegments>(null);
  const heat = useRef(new Float32Array(sim.map.n));
  const lastT = useRef(-1);
  const maxRibbon = sim.robots.length * 25;
  const tmp = useMemo(() => ({ m: new THREE.Matrix4(), q: new THREE.Quaternion(), s: new THREE.Vector3(), p: new THREE.Vector3(), c: new THREE.Color(), e: new THREE.Euler() }), []);

  const mkLines = (n: number) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    return g;
  };
  const packetGeo = useMemo(() => mkLines(800), []);
  const lineGeo = useMemo(() => mkLines(4000), []);

  // Bold hazard wrap: three wide amber/black bands that stay legible at any zoom.
  const stripeTex = useMemo(() => {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 128;
    const x = cv.getContext('2d')!;
    x.fillStyle = '#141414';
    x.fillRect(0, 0, 128, 128);
    x.fillStyle = '#fbbf24';
    for (let i = -128; i < 256; i += 64) {
      x.beginPath();
      x.moveTo(i, 0);
      x.lineTo(i + 32, 0);
      x.lineTo(i + 32 - 128, 128);
      x.lineTo(i - 128, 128);
      x.fill();
    }
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  }, []);
  const palletBaseRef = useRef<THREE.InstancedMesh>(null);
  const palletTileRef = useRef<THREE.InstancedMesh>(null);

  useFrame(() => {
    const s = get();
    if (!s) return;
    const { m, q, p, c, e } = tmp;
    const sc = tmp.s;
    const v = controller.view;
    const now = performance.now();
    const pulse = 0.5 + 0.5 * Math.sin(now / 220);
    const W = s.map.width;
    const Hh = s.map.height;
    const tw = (cell: number, y = 0) => {
      p.set(s.map.x(cell) - W / 2 + 0.5, y, s.map.y(cell) - Hh / 2 + 0.5);
      return p;
    };

    if (s.t !== lastT.current) {
      lastT.current = s.t;
      for (const r of s.robots) heat.current[r.pos] += 1;
    }

    // Protected "unknown ≠ free" zones
    if (zoneRef.current) {
      const cells = new Set<number>();
      const src = controller.beliefOf >= 0 ? [s.agents[controller.beliefOf]] : s.agents;
      if (v.zones) for (const a of src) if (a instanceof AnvayaAgent) for (const cc of a.debug.protectedCells) cells.add(cc);
      let i = 0;
      for (const cc of cells) {
        if (i >= 600) break;
        m.compose(tw(cc, 0.02), q, sc.set(0.96, 1, 0.96));
        zoneRef.current.setMatrixAt(i++, m);
      }
      zoneRef.current.count = i;
      zoneRef.current.instanceMatrix.needsUpdate = true;
      (zoneRef.current.material as THREE.MeshBasicMaterial).opacity = 0.22 + pulse * 0.22;
    }

    // Space-time ribbons (height = seconds into the future)
    if (ribbonRef.current) {
      let i = 0;
      if (v.ribbons) {
        s.robots.forEach((r, ri) => {
          const plan = r.plan;
          for (let t = 1; t < plan.length && i < maxRibbon; t++) {
            m.compose(tw(plan[t], 0.15 + t * 0.32), q, sc.set(0.72, 0.08, 0.72));
            ribbonRef.current!.setMatrixAt(i, m);
            c.set(ROBOT_COLORS[ri % ROBOT_COLORS.length]);
            const dim = controller.selected >= 0 && controller.selected !== ri ? 0.25 : 1;
            c.multiplyScalar((1 - (t / (plan.length + 2)) * 0.55) * dim);
            ribbonRef.current!.setColorAt(i, c);
            i++;
          }
        });
      }
      ribbonRef.current.count = i;
      ribbonRef.current.instanceMatrix.needsUpdate = true;
      if (ribbonRef.current.instanceColor) ribbonRef.current.instanceColor.needsUpdate = true;
    }

    // Pallets dropped in aisles: wooden base + hazard-wrapped load + pulsing red floor tile
    if (palletRef.current && palletBaseRef.current && palletTileRef.current) {
      let i = 0;
      for (const cc of s.blocked) {
        if (i >= 64) break;
        m.compose(tw(cc, 0.36), q, sc.set(0.7, 0.48, 0.7));
        palletRef.current.setMatrixAt(i, m);
        m.compose(tw(cc, 0.06), q, sc.set(0.8, 0.12, 0.8));
        palletBaseRef.current.setMatrixAt(i, m);
        m.compose(tw(cc, 0.012), q, sc.set(0.98, 1, 0.98));
        palletTileRef.current.setMatrixAt(i, m);
        i++;
      }
      for (const r of [palletRef, palletBaseRef, palletTileRef]) {
        r.current!.count = i;
        r.current!.instanceMatrix.needsUpdate = true;
      }
      (palletTileRef.current.material as THREE.MeshBasicMaterial).opacity = 0.3 + pulse * 0.35;
    }

    // Open orders: floating diamonds above the pickup face, coloured by priority
    if (taskRef.current) {
      let i = 0;
      for (const t of s.tasks.values()) {
        if (t.pickedAt !== null || t.doneAt !== null) continue;
        if (i >= 120) break;
        e.set(0, now / 900 + i, Math.PI / 4);
        q.setFromEuler(e);
        m.compose(tw(t.pickup, 1.75 + Math.sin(now / 400 + i) * 0.06), q, sc.set(0.2, 0.2, 0.2));
        taskRef.current.setMatrixAt(i, m);
        c.set(PRIO_COLOR[t.priority]);
        taskRef.current.setColorAt(i, c);
        i++;
      }
      q.identity();
      taskRef.current.count = i;
      taskRef.current.instanceMatrix.needsUpdate = true;
      if (taskRef.current.instanceColor) taskRef.current.instanceColor.needsUpdate = true;
    }

    // Congestion heatmap
    if (heatRef.current) {
      let i = 0;
      if (v.heat) {
        let max = 1;
        for (let k = 0; k < heat.current.length; k++) if (heat.current[k] > max) max = heat.current[k];
        for (let k = 0; k < heat.current.length; k++) {
          const h = heat.current[k];
          if (h <= 0) continue;
          m.compose(tw(k, 0.008), q, sc.set(0.98, 1, 0.98));
          heatRef.current.setMatrixAt(i, m);
          const u = Math.sqrt(h / max);
          c.setRGB(0.2 + u * 0.8, 0.9 - u * 0.6, 0.2);
          heatRef.current.setColorAt(i, c);
          i++;
        }
      }
      heatRef.current.count = i;
      heatRef.current.instanceMatrix.needsUpdate = true;
      if (heatRef.current.instanceColor) heatRef.current.instanceColor.needsUpdate = true;
    }

    // Planned paths (robot colour) + yield links (amber) as one line buffer
    if (linesRef.current) {
      const g = linesRef.current.geometry as THREE.BufferGeometry;
      const pos = g.getAttribute('position') as THREE.BufferAttribute;
      const col = g.getAttribute('color') as THREE.BufferAttribute;
      let n = 0;
      const seg = (a: number, b: number, y: number, colr: THREE.Color) => {
        if (n >= 1990) return;
        const A = tw(a, y);
        pos.setXYZ(n * 2, A.x, A.y, A.z);
        const B = tw(b, y);
        pos.setXYZ(n * 2 + 1, B.x, B.y, B.z);
        col.setXYZ(n * 2, colr.r, colr.g, colr.b);
        col.setXYZ(n * 2 + 1, colr.r, colr.g, colr.b);
        n++;
      };
      s.robots.forEach((r, i) => {
        if (v.paths && (controller.selected < 0 || controller.selected === i)) {
          c.set(ROBOT_COLORS[i % ROBOT_COLORS.length]);
          for (let k = 1; k < r.plan.length; k++) if (r.plan[k] !== r.plan[k - 1]) seg(r.plan[k - 1], r.plan[k], 0.06, c);
        }
        if (r.yieldTo >= 0 && (r.action === 'YIELD' || r.action === 'HOLD') && s.robots[r.yieldTo]) {
          c.set('#fbbf24');
          seg(r.pos, s.robots[r.yieldTo].pos, 1.1, c);
        }
      });
      g.setDrawRange(0, n * 2);
      pos.needsUpdate = true;
      col.needsUpdate = true;
    }

    // P2P packets of the latest tick
    if (packetsRef.current) {
      const g = packetsRef.current.geometry as THREE.BufferGeometry;
      const pos = g.getAttribute('position') as THREE.BufferAttribute;
      const col = g.getAttribute('color') as THREE.BufferAttribute;
      let n = 0;
      if (v.packets) {
        const sel = controller.selected;
        const k = controller.alpha;
        for (const pl of s.net.pulses) {
          if (n >= 380) break;
          if (pl.fromCell < 0) continue;
          if (sel >= 0 && pl.from !== sel && pl.to !== sel) continue;
          if (sel < 0 && !pl.dropped && (pl.from + pl.to + s.t) % 4 !== 0) continue;
          const ax = s.map.x(pl.fromCell) - W / 2 + 0.5;
          const az = s.map.y(pl.fromCell) - Hh / 2 + 0.5;
          const bx = s.map.x(pl.toCell) - W / 2 + 0.5;
          const bz = s.map.y(pl.toCell) - Hh / 2 + 0.5;
          const t0 = Math.min(1, k * 1.2);
          const t1 = Math.max(0, t0 - 0.25);
          const lift = (tt: number) => 1.0 + Math.sin(tt * Math.PI) * 1.4;
          pos.setXYZ(n * 2, ax + (bx - ax) * t1, lift(t1), az + (bz - az) * t1);
          pos.setXYZ(n * 2 + 1, ax + (bx - ax) * t0, lift(t0), az + (bz - az) * t0);
          c.set(pl.dropped ? '#f87171' : pl.tag === 'forged' || pl.tag === 'replay' ? '#e879f9' : '#bef264');
          col.setXYZ(n * 2, c.r * 0.2, c.g * 0.2, c.b * 0.2);
          col.setXYZ(n * 2 + 1, c.r, c.g, c.b);
          n++;
        }
      }
      g.setDrawRange(0, n * 2);
      pos.needsUpdate = true;
      col.needsUpdate = true;
    }
  });

  return (
    <group>
      <instancedMesh ref={heatRef} count={0} args={[undefined, undefined, sim.map.n]}>
        <boxGeometry args={[1, 0.004, 1]} />
        <meshBasicMaterial transparent opacity={0.4} toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={zoneRef} count={0} args={[undefined, undefined, 600]}>
        <boxGeometry args={[1, 0.03, 1]} />
        <meshBasicMaterial color="#ef4444" transparent opacity={0.3} toneMapped={false} depthWrite={false} />
      </instancedMesh>
      <instancedMesh ref={ribbonRef} count={0} args={[undefined, undefined, Math.max(1, maxRibbon)]}>
        <boxGeometry />
        <meshStandardMaterial transparent opacity={0.75} emissive="#ffffff" emissiveIntensity={0.18} toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={palletTileRef} count={0} args={[undefined, undefined, 64]} frustumCulled={false}>
        <boxGeometry args={[1, 0.01, 1]} />
        <meshBasicMaterial color="#ef4444" transparent opacity={0.5} toneMapped={false} depthWrite={false} />
      </instancedMesh>
      <instancedMesh ref={palletBaseRef} count={0} args={[undefined, undefined, 64]} castShadow frustumCulled={false}>
        <boxGeometry />
        <meshStandardMaterial color="#7c5a3a" roughness={0.9} />
      </instancedMesh>
      <instancedMesh ref={palletRef} count={0} args={[undefined, undefined, 64]} castShadow frustumCulled={false}>
        <boxGeometry />
        <meshStandardMaterial map={stripeTex} roughness={0.6} emissive="#3a2a00" emissiveIntensity={0.4} />
      </instancedMesh>
      <instancedMesh ref={taskRef} count={0} args={[undefined, undefined, 120]}>
        <octahedronGeometry args={[1, 0]} />
        <meshStandardMaterial emissive="#ffffff" emissiveIntensity={0.35} toneMapped={false} />
      </instancedMesh>
      <lineSegments ref={linesRef} geometry={lineGeo}>
        <lineBasicMaterial vertexColors transparent opacity={0.95} toneMapped={false} />
      </lineSegments>
      <lineSegments ref={packetsRef} geometry={packetGeo}>
        <lineBasicMaterial vertexColors transparent opacity={0.95} toneMapped={false} />
      </lineSegments>
    </group>
  );
}

/* =============================================================== robots (per frame) */
function Robot({ get, i, groups, sim }: { get: Getter; i: number; sim: Simulation; groups: React.MutableRefObject<(THREE.Group | null)[]> }) {
  const g = useRef<THREE.Group>(null);
  const body = useRef<THREE.Group>(null);
  const statusMat = useRef<THREE.MeshBasicMaterial>(null);
  const selRing = useRef<THREE.Mesh>(null);
  const crate = useRef<THREE.Group>(null);
  const heading = useRef<number | null>(null);
  const color = ROBOT_COLORS[i % ROBOT_COLORS.length];
  const tmpC = useMemo(() => new THREE.Color(), []);

  useEffect(() => {
    groups.current[i] = g.current;
    return () => {
      groups.current[i] = null;
    };
  }, [groups, i]);

  useFrame((_, dt) => {
    const s = get();
    if (!s || !g.current) return;
    const r = s.robots[i];
    if (!r) return;
    const k = controller.alpha;
    const ax = s.map.x(r.prev);
    const ay = s.map.y(r.prev);
    const bx = s.map.x(r.pos);
    const by = s.map.y(r.pos);
    const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; // ease in-out between ticks
    g.current.position.set(ax + (bx - ax) * e - s.map.width / 2 + 0.5, 0, ay + (by - ay) * e - s.map.height / 2 + 0.5);
    if (heading.current === null) heading.current = r.heading ? Math.PI / 2 - r.heading : 0;
    if (r.prev !== r.pos) {
      const target = Math.atan2(bx - ax, by - ay);
      let d = target - heading.current;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      heading.current += d * Math.min(1, dt * 10);
    }
    if (body.current) body.current.rotation.y = heading.current;
    if (statusMat.current) {
      tmpC.set(r.quarantined ? '#f87171' : ACTION_COLOR[r.action] ?? '#94a3b8');
      statusMat.current.color.copy(tmpC);
      statusMat.current.opacity = r.action === 'YIELD' || r.action === 'HOLD' ? 0.55 + 0.35 * Math.sin(performance.now() / 150) : 0.75;
    }
    if (selRing.current) {
      selRing.current.visible = controller.selected === i;
      selRing.current.rotation.z += dt * 1.6;
    }
    if (crate.current) crate.current.visible = !!r.carrying;
  });

  return (
    <group
      ref={g}
      onClick={(ev) => {
        ev.stopPropagation();
        controller.selected = controller.selected === i ? -1 : i;
        controller.notify();
      }}
      onPointerOver={(ev) => {
        ev.stopPropagation();
        document.body.dataset.robotHover = '1';
      }}
      onPointerOut={() => {
        delete document.body.dataset.robotHover;
      }}
    >
      {/* generous invisible hit area so moving robots are easy to click */}
      <mesh position={[0, 0.5, 0]}>
        <cylinderGeometry args={[0.5, 0.5, 1.2, 12]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      {/* status light pool on the floor: colour = the robot's current decision */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.015, 0]}>
        <circleGeometry args={[0.44, 32]} />
        <meshBasicMaterial ref={statusMat} color="#a3e635" transparent opacity={0.75} toneMapped={false} />
      </mesh>
      <mesh ref={selRing} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]} visible={false}>
        <ringGeometry args={[0.44, 0.5, 40, 1, 0, Math.PI * 1.6]} />
        <meshBasicMaterial color="#ffffff" toneMapped={false} />
      </mesh>
      {/* Footprint fits inside one 1.2 m cell even mid-turn (half-diagonal 0.47 < 0.5 cell). */}
      <group ref={body} scale={0.78}>
        <AmrModel accent={color} status={color} detail={sim.robots.length > 14 ? 'low' : 'high'} />
        <group ref={crate} position={[0, 0.36, 0]} visible={false}>
          <mesh position={[0, 0.17, 0]} castShadow>
            <boxGeometry args={[0.52, 0.32, 0.52]} />
            <meshStandardMaterial color="#c9905a" roughness={0.75} />
          </mesh>
        </group>
      </group>
    </group>
  );
}

/* =============================================================== labels (DOM, projected) */
function LabelProjector({ groups, labels }: { groups: React.MutableRefObject<(THREE.Group | null)[]>; labels: React.MutableRefObject<(HTMLDivElement | null)[]> }) {
  const { camera, size } = useThree();
  const v = useMemo(() => new THREE.Vector3(), []);
  useFrame(() => {
    for (let i = 0; i < labels.current.length; i++) {
      const el = labels.current[i];
      const g = groups.current[i];
      if (!el) continue;
      if (!g || !controller.view.labels) {
        el.style.display = 'none';
        continue;
      }
      g.getWorldPosition(v);
      v.y += 1.25;
      v.project(camera);
      if (v.z > 1 || v.x < -1.1 || v.x > 1.1 || v.y < -1.1 || v.y > 1.1) {
        el.style.display = 'none';
        continue;
      }
      el.style.display = '';
      el.style.transform = `translate(-50%, -100%) translate(${((v.x + 1) / 2) * size.width}px, ${((1 - v.y) / 2) * size.height}px)`;
    }
  });
  return null;
}

function TwinLabels({ get, labels, primary }: { get: Getter; labels: React.MutableRefObject<(HTMLDivElement | null)[]>; primary: boolean }) {
  const [, force] = useState(0);
  useEffect(() => controller.subscribe(() => force((x) => x + 1)), []);
  const sim = get();
  if (!sim) return null;
  return (
    <div className="twin-labels">
      {sim.robots.map((r, i) => {
        const color = ROBOT_COLORS[i % ROBOT_COLORS.length];
        const status = r.quarantined ? '#f87171' : ACTION_COLOR[r.action] ?? '#999';
        const flag = r.quarantined ? 'QUARANTINED' : r.faults.blackoutUntil >= 0 ? 'NO RADIO' : r.faults.motor ? 'DRIVE FAULT' : r.faults.rogue ? 'COMPROMISED' : r.action !== 'GO' ? r.action : '';
        return (
          <div
            key={i}
            ref={(el) => {
              labels.current[i] = el;
            }}
            className={`twin-tag ${controller.selected === i ? 'sel' : ''}`}
            style={{ borderColor: color, display: 'none' }}
          >
            <span className="sw" style={{ background: color }} />R{i + 1}
            {primary && flag && <span className="act" style={{ color: status }}>{flag}</span>}
          </div>
        );
      })}
    </div>
  );
}

/* =============================================================== interaction */
function Picker({ sim, primary }: { sim: Simulation; primary: boolean }) {
  const W = sim.map.width;
  const H = sim.map.height;
  const hover = useRef<THREE.Mesh>(null);
  const onMove = (e: ThreeEvent<PointerEvent>) => {
    if (!hover.current) return;
    const x = Math.floor(e.point.x + W / 2);
    const y = Math.floor(e.point.z + H / 2);
    const ok = sim.map.inBounds(x, y) && controller.tool !== 'select';
    hover.current.visible = ok;
    if (ok) hover.current.position.set(x - W / 2 + 0.5, 0.025, y - H / 2 + 0.5);
  };
  const onClick = (e: ThreeEvent<MouseEvent>) => {
    if (!primary || e.delta > 4) return; // a drag orbits the camera
    const x = Math.floor(e.point.x + W / 2);
    const y = Math.floor(e.point.z + H / 2);
    if (!sim.map.inBounds(x, y)) return;
    const c = sim.map.idx(x, y);
    const tool = controller.tool;
    if (tool === 'select') {
      controller.selected = -1;
      controller.notify();
    } else if (tool === 'block') controller.toggleBlock(c);
    else if (tool === 'deadzone') controller.toggleDeadZone(c);
    else if (tool === 'order' && sim.map.walkable(c)) {
      if (controller.orderDraft.pickup === null) {
        controller.orderDraft.pickup = c;
        controller.notify();
      } else {
        controller.injectOrder(controller.orderDraft.pickup, c, 'URGENT');
        controller.orderDraft.pickup = null;
      }
    }
  };
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.002, 0]} onPointerMove={onMove} onClick={onClick} onPointerOut={() => hover.current && (hover.current.visible = false)}>
        <planeGeometry args={[W, H]} />
        <meshBasicMaterial visible={false} />
      </mesh>
      <mesh ref={hover} rotation={[-Math.PI / 2, 0, 0]} visible={false}>
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial color="#a3e635" transparent opacity={0.45} toneMapped={false} />
      </mesh>
    </group>
  );
}

/* =============================================================== camera */
export type CamMode = 'iso' | 'top' | 'follow' | 'low';
function CameraRig({ get, sim, mode, nonce, controls }: { get: Getter; sim: Simulation; mode: CamMode; nonce: number; controls: React.RefObject<OrbitImpl | null> }) {
  const { camera } = useThree();
  const span = Math.max(sim.map.width, sim.map.height);
  const target = useMemo(() => new THREE.Vector3(), []);
  const eye = useMemo(() => new THREE.Vector3(), []);
  const anim = useRef<{ from: THREE.Vector3; to: THREE.Vector3; fromT: THREE.Vector3; t: number } | null>(null);
  const first = useRef(true);
  // Every view choice (including re-selecting the current one) glides back to its default framing.
  const { size } = useThree();
  useEffect(() => {
    // Fit the floor in both directions: narrow (portrait) panels need the camera further back.
    const aspect = size.width / Math.max(1, size.height);
    const d = span * Math.max(1, 1.25 / Math.max(0.5, aspect));
    const to = new THREE.Vector3();
    if (mode === 'top') to.set(0, d * 1.6, 0.01);
    else if (mode === 'low') to.set(d * 1.0, d * 0.38, d * 0.62);
    else to.set(d * 0.5, d * 1.25, d * 0.95); // iso (and follow's starting point)
    if (mode === 'follow' && controller.selected >= 0) return;
    const c = controls.current;
    if (first.current) {
      first.current = false;
      camera.position.copy(to);
      c?.target.set(0, 0, 0);
      c?.update();
      return;
    }
    anim.current = { from: camera.position.clone(), to, fromT: c ? c.target.clone() : new THREE.Vector3(), t: 0 };
  }, [mode, nonce, span, camera, controls, size.width, size.height]);
  useFrame((_, dt) => {
    const c = controls.current;
    const a = anim.current;
    if (a && c) {
      a.t = Math.min(1, a.t + dt / 0.7);
      const k = 1 - Math.pow(1 - a.t, 3); // ease-out
      camera.position.lerpVectors(a.from, a.to, k);
      c.target.lerpVectors(a.fromT, target.set(0, 0, 0), k);
      c.update();
      if (a.t >= 1) anim.current = null;
      return;
    }
    if (mode !== 'follow' || controller.selected < 0) return;
    const s = get();
    const r = s?.robots[controller.selected];
    if (!s || !r || !c) return;
    const x = s.map.x(r.pos) - s.map.width / 2 + 0.5;
    const z = s.map.y(r.pos) - s.map.height / 2 + 0.5;
    c.target.lerp(target.set(x, 0, z), Math.min(1, dt * 3));
    camera.position.lerp(eye.set(x + 5, 7, z + 7), Math.min(1, dt * 2));
    c.update();
  });
  return null;
}

/* =============================================================== public component */
function TwinImpl({ which = 'main', cam = 'iso', loadId, quality = 'high', camNonce = 0, interactive = true }: { which?: 'main' | 'twin'; cam?: CamMode; loadId: number; quality?: 'high' | 'low'; camNonce?: number; interactive?: boolean }) {
  const get: Getter = which === 'main' ? () => controller.sim : () => controller.twin;
  const controls = useRef<OrbitImpl | null>(null);
  const groups = useRef<(THREE.Group | null)[]>([]);
  const labels = useRef<(HTMLDivElement | null)[]>([]);
  const wrap = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(true);

  // Pause rendering entirely when the view is scrolled off-screen.
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => setVisible(es[0].isIntersecting), { rootMargin: '100px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const sim = get();
  if (!sim) return null;
  const shadows = quality === 'high';
  return (
    <div className={`twin-wrap ${interactive ? '' : 'view-only'}`} ref={wrap}>
      <Canvas shadows={shadows} frameloop={visible ? 'always' : 'never'} dpr={[1, quality === 'high' ? 1.75 : 1.25]} camera={{ fov: 40, near: 0.1, far: 400 }} gl={{ antialias: true }}>
        <color attach="background" args={['#0c0e0e']} />
        <fog attach="fog" args={['#0c0e0e', 60, 140]} />
        <ambientLight intensity={0.85} />
        <hemisphereLight args={['#f1f5e9', '#1c1f1d', 0.9]} />
        <directionalLight position={[14, 26, 12]} intensity={2.4} castShadow={shadows} shadow-mapSize={[2048, 2048]} shadow-camera-left={-22} shadow-camera-right={22} shadow-camera-top={22} shadow-camera-bottom={-22} />
        <directionalLight position={[-16, 12, -10]} intensity={0.8} color="#d9f99d" />
        <Warehouse sim={sim} />
        <DeadZones get={get} />
        <Dynamic get={get} sim={sim} />
        {sim.robots.map((_, i) => (
          <Robot key={i} get={get} i={i} sim={sim} groups={groups} />
        ))}
        <Picker sim={sim} primary={which === 'main'} />
        <LabelProjector groups={groups} labels={labels} />
        <OrbitControls ref={controls as never} makeDefault enabled={interactive} enableZoom={interactive} maxPolarAngle={Math.PI / 2.1} minDistance={4} maxDistance={Math.max(sim.map.width, sim.map.height) * 2.1} enableDamping />
        <CameraRig get={get} sim={sim} mode={cam} nonce={camNonce} controls={controls} />
      </Canvas>
      <TwinLabels get={get} labels={labels} primary={which === 'main'} />
    </div>
  );
}

/**
 * Memoised: parent panels re-render every tick, the 3D scene must not.
 * Keyed by loadId so a new scenario gets a fresh scene (and a fresh visibility watcher).
 */
export const Twin = memo(function Twin(props: { which?: 'main' | 'twin'; cam?: CamMode; loadId: number; quality?: 'high' | 'low'; camNonce?: number; interactive?: boolean }) {
  return <TwinImpl key={props.loadId} {...props} />;
});
