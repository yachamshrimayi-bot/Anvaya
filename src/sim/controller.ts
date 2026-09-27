import { AnvayaAgent } from '../engine/anvaya';
import { makeScenario } from '../engine/scenarios';
import { Simulation } from '../engine/sim';
import { cloneDeep } from '../engine/snapshot';
import type { Cell, FaultKind, NetworkParams, Priority, SimConfig } from '../engine/types';

export const ROBOT_COLORS = [
  '#c9f46b', '#5eead4', '#fb8f6b', '#f472b6', '#7dd3fc', '#a78bfa', '#fbbf24', '#fb7185',
  '#2dd4bf', '#818cf8', '#fde047', '#fdba74', '#86efac', '#e879f9', '#93c5fd', '#fca5a5',
  '#bef264', '#67e8f9', '#f0abfc', '#fcd34d', '#a5b4fc', '#6ee7b7', '#fda4af', '#d9f99d',
];

export type ViewToggles = {
  ribbons: boolean;
  paths: boolean;
  packets: boolean;
  zones: boolean;
  heat: boolean;
  labels: boolean;
};

export type Tool = 'select' | 'block' | 'deadzone' | 'order';

type Listener = () => void;

/** An operator action, recorded so time travel can replay it exactly. */
type Action = { t: number; run: (sim: Simulation, isTwin: boolean) => void };
type Snapshot = { t: number; sim: Simulation; twin: Simulation | null };
export type Marker = { t: number; kind: string; text: string };

/**
 * Owns the live digital twin(s) and the clock. The 3D view reads state directly
 * each frame; React panels subscribe to a throttled change signal.
 */
export class SimController {
  sim: Simulation;
  twin: Simulation | null = null; // baseline twin for side-by-side comparison
  cfg: SimConfig;
  scenarioId = 'rush';
  playing = false;
  ticksPerSecond = 2;
  /** 0..1 progress between the previous and the current tick (render interpolation). */
  alpha = 1;
  selected = -1;
  beliefOf = -1; // render the world as this robot believes it
  view: ViewToggles = { ribbons: false, paths: true, packets: true, zones: true, heat: false, labels: true };
  tool: Tool = 'select';
  compare = false;
  captions: { t: number; text: string }[] = [];
  private acc = 0;
  private last = 0;
  private raf = 0;
  private listeners = new Set<Listener>();
  private notifyPending = false;
  version = 0;
  loadId = 0;
  stepMs = 0;
  orderDraft: { pickup: Cell | null } = { pickup: null };

  // ------------------------------------------------------------ time travel
  /** Furthest tick reached in the current branch of history. */
  headT = 0;
  private snaps: Snapshot[] = [];
  private actions: Action[] = [];
  private snapEvery = 10;
  markers: Marker[] = [];

  constructor() {
    this.cfg = makeScenario(this.scenarioId, 7);
    this.sim = new Simulation(this.cfg);
    this.snapshot();
  }

  // ---------------------------------------------------------------- lifecycle
  start(): void {
    if (this.raf) return;
    this.last = performance.now();
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop);
      const dt = Math.min(0.25, (now - this.last) / 1000);
      this.last = now;
      if (this.playing) {
        this.acc += dt * this.ticksPerSecond;
        let steps = 0;
        while (this.acc >= 1 && steps < 4) {
          this.stepOnce();
          this.acc -= 1;
          steps++;
        }
        if (steps === 4) this.acc = 0;
        this.alpha = Math.min(1, this.acc);
      } else this.alpha = 1;
    };
    this.raf = requestAnimationFrame(loop);
  }
  stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  notify(): void {
    this.version++;
    if (this.notifyPending) return;
    this.notifyPending = true;
    setTimeout(() => {
      this.notifyPending = false;
      for (const l of this.listeners) l();
    }, 90);
  }

  stepOnce(): void {
    const t0 = performance.now();
    this.sim.step();
    if (this.twin) this.twin.step();
    this.applyActionsAt(this.sim.t);
    if (this.sim.t % this.snapEvery === 0 && !this.snaps.some((x) => x.t === this.sim.t)) this.snapshot();
    if (this.sim.t > this.headT) {
      this.headT = this.sim.t;
      this.collectMarkers();
    }
    this.stepMs = this.stepMs * 0.85 + (performance.now() - t0) * 0.15;
    for (const c of this.sim.captions) if (!this.captions.some((x) => x.t === c.t && x.text === c.text)) this.captions.push({ t: c.t, text: c.text });
    if (this.captions.length > 20) this.captions.splice(0, this.captions.length - 20);
    this.notify();
  }

  // ---------------------------------------------------------------- setup
  load(cfg: SimConfig, scenarioId?: string): void {
    this.cfg = structuredClone(cfg);
    if (scenarioId) this.scenarioId = scenarioId;
    this.sim = new Simulation(this.cfg);
    this.twin = this.compare ? this.makeTwin() : null;
    this.captions = [];
    this.selected = -1;
    this.beliefOf = -1;
    this.acc = 0;
    this.headT = 0;
    this.snaps = [];
    this.actions = [];
    this.markers = [];
    this.snapEvery = 10;
    this.snapshot();
    this.loadId++;
    this.notify();
  }
  loadScenario(id: string, seed?: number): void {
    const s = seed ?? (id === 'random' ? Math.floor(Math.random() * 100000) : 7);
    this.load(makeScenario(id, s), id);
  }
  reset(): void {
    this.load(this.cfg);
  }
  private makeTwin(): Simulation {
    const c = structuredClone(this.cfg);
    c.planner = c.planner === 'anvaya' ? 'baseline' : 'anvaya';
    c.crypto = false;
    return new Simulation(c);
  }
  setCompare(on: boolean): void {
    this.compare = on;
    // Restart both from t=0 so they face the identical day.
    this.load(this.cfg);
  }

  // ------------------------------------------------------------ time travel core
  private shared(sim: Simulation): object[] {
    return [sim.map, sim.registry, sim.wms, ...sim.identities];
  }
  private snapshot(): void {
    this.snaps.push({ t: this.sim.t, sim: cloneDeep(this.sim, this.shared(this.sim)), twin: this.twin ? cloneDeep(this.twin, this.shared(this.twin)) : null });
    this.snaps.sort((a, b) => a.t - b.t);
    // Memory budget (~3 MB per 12-robot snapshot): thin old snapshots, doubling their spacing.
    const budget = Math.max(8, Math.floor(480 / Math.max(4, this.sim.robots.length)));
    if (this.snaps.length > budget) {
      this.snapEvery *= 2;
      this.snaps = this.snaps.filter((x, i) => x.t === 0 || x.t % this.snapEvery === 0 || i === this.snaps.length - 1);
    }
  }
  private applyActionsAt(t: number): void {
    for (const a of this.actions) if (a.t === t) {
      a.run(this.sim, false);
      if (this.twin) a.run(this.twin, true);
    }
  }
  /** Run an operator action now and record it. Acting in the past starts a new branch. */
  private act(run: Action['run']): void {
    if (this.sim.t < this.headT) {
      this.snaps = this.snaps.filter((x) => x.t <= this.sim.t);
      this.actions = this.actions.filter((a) => a.t <= this.sim.t);
      this.headT = this.sim.t;
      this.markers = this.markers.filter((m) => m.t <= this.sim.t);
    }
    this.actions.push({ t: this.sim.t, run });
    run(this.sim, false);
    if (this.twin) run(this.twin, true);
    this.notify();
  }
  private collectMarkers(): void {
    // One marker per distinct event (numbers stripped), repeats within 20 s collapse.
    const norm = (x: string) => x.replace(/[\d.→×]+/g, '#').replace(/\s+/g, ' ');
    const lastAt = new Map<string, number>();
    for (const m of this.markers) lastAt.set(norm(m.text), m.t);
    for (const l of this.sim.log.slice(-40)) {
      if (!['fault', 'security', 'trust', 'safety'].includes(l.kind)) continue;
      if (l.t < this.headT - 1) continue;
      const key = norm(l.text);
      const prev = lastAt.get(key);
      if (prev !== undefined && l.t - prev < 20) continue;
      lastAt.set(key, l.t);
      this.markers.push({ t: l.t, kind: l.kind, text: l.text });
    }
    if (this.markers.length > 200) this.markers.splice(0, this.markers.length - 200);
  }
  /** Rewind / fast-forward to tick T within the current branch (exact: snapshot + re-simulation). */
  seek(T: number): void {
    const target = Math.max(0, Math.min(this.headT, Math.round(T)));
    if (target === this.sim.t) return;
    this.playing = false;
    let base: Snapshot | undefined;
    if (target > this.sim.t && target - this.sim.t <= this.snapEvery) base = undefined; // just step forward
    else for (const x of this.snaps) if (x.t <= target) base = x;
    if (base) {
      this.sim = cloneDeep(base.sim, this.shared(base.sim));
      this.twin = base.twin ? cloneDeep(base.twin, this.shared(base.twin)) : null;
      this.applyActionsAt(this.sim.t);
    }
    while (this.sim.t < target) {
      this.sim.step();
      if (this.twin) this.twin.step();
      this.applyActionsAt(this.sim.t);
    }
    this.captions = this.sim.captions.filter((c) => c.t <= this.sim.t).map((c) => ({ t: c.t, text: c.text }));
    this.alpha = 1;
    this.notify();
  }
  get live(): boolean {
    return this.sim.t >= this.headT;
  }

  /** Live-editable parameters apply immediately to every robot's controller. */
  patchAlgo(p: Partial<SimConfig['algo']>): void {
    Object.assign(this.cfg.algo, p);
    const q = { ...p };
    this.act((s) => {
      Object.assign(s.cfg.algo, q);
      for (const a of s.agents) a.algo = s.cfg.algo;
    });
  }
  patchNet(p: Partial<NetworkParams>): void {
    Object.assign(this.cfg.net, p);
    const q = { ...p };
    this.act((s) => {
      s.setNetwork(q);
      for (const a of s.agents) a.algo = s.cfg.algo;
    });
  }
  /** Parameters that change the world itself need a fresh run. */
  patchWorld(p: Partial<SimConfig>): void {
    Object.assign(this.cfg, p);
    this.load(this.cfg);
  }

  // ---------------------------------------------------------------- operator actions
  fault(robot: number, f: FaultKind, duration?: number): void {
    this.act((s) => s.injectFault(robot, f, duration));
  }
  spoof(target: number): void {
    this.act((s, twin) => {
      if (!twin) s.spoof(target);
    });
  }
  replay(target: number): void {
    this.act((s, twin) => {
      if (!twin) s.replay(target);
    });
  }
  toggleBlock(cell: Cell): void {
    this.act((s) => {
      s.toggleBlock(cell);
    });
  }
  releaseOrders(n: number): void {
    this.act((s) => {
      for (let i = 0; i < n; i++) s.releaseOrder();
    });
  }
  toggleDeadZone(cell: Cell): void {
    this.act((s) => {
      const x = s.map.x(cell);
      const y = s.map.y(cell);
      const zones = s.net.deadZones;
      const hit = zones.findIndex((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
      if (hit >= 0) zones.splice(hit, 1);
      else zones.push({ x: Math.max(0, x - 1), y: Math.max(0, y - 1), w: 3, h: 3 });
    });
  }
  injectOrder(pickup: Cell, drop: Cell, priority: Priority): void {
    this.act((s) => {
      s.releaseOrder({ pickup, drop, priority });
    });
  }

  // ---------------------------------------------------------------- derived
  agent(i: number): AnvayaAgent | null {
    const a = this.sim.agents[i];
    return a instanceof AnvayaAgent ? a : null;
  }
  color(i: number): string {
    return ROBOT_COLORS[i % ROBOT_COLORS.length];
  }
}

export const controller = new SimController();
