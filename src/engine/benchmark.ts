import { buildMap } from './grid';
import { baseConfig } from './scenarios';
import { Simulation } from './sim';
import type { SimConfig, TimelineEvent } from './types';

/**
 * Reproducible benchmark: 5 families × N seeds, every trial run for every planner
 * variant on the *identical* warehouse, fleet, order list and fault timeline.
 * Nothing is precomputed — the browser runs this live in a Web Worker, and
 * `npm run bench` runs the same code headless.
 */

export interface Family {
  id: string;
  title: string;
  detail: string;
}

export const FAMILIES: Family[] = [
  { id: 'storm', title: 'Intersection storm', detail: 'Cross-dock floor, 10 AMRs, 30 orders' },
  { id: 'lanes', title: 'Single-lane aisles', detail: 'Narrow layout, 8 AMRs, 32 orders' },
  { id: 'dense', title: 'Dense fulfilment', detail: 'Pick aisles, 12 AMRs, 48 orders' },
  { id: 'blocked', title: 'Blocked aisle', detail: 'Pallet drops in the main cross-aisle at t=20' },
  { id: 'lossy', title: 'Lossy network', detail: '15% packet loss + one robot radio blackout' },
];

export interface Variant {
  id: string;
  title: string;
  kind: 'anvaya' | 'baseline';
  patch?: Partial<SimConfig['algo']>;
}

export const VARIANTS: Variant[] = [
  { id: 'anvaya', title: 'ANVAYA (full)', kind: 'anvaya' },
  { id: 'baseline', title: 'Stop-and-wait baseline', kind: 'baseline' },
  { id: 'no-fleetcost', title: 'ANVAYA − fleet-wide cost', kind: 'anvaya', patch: { useFleetCost: false } },
  { id: 'no-fairness', title: 'ANVAYA − fairness/aging', kind: 'anvaya', patch: { useFairness: false } },
  { id: 'short-horizon', title: 'ANVAYA − prediction (horizon 3)', kind: 'anvaya', patch: { horizon: 3 } },
];

export interface TrialResult {
  family: string;
  seed: number;
  variant: string;
  ticks: number;
  completed: boolean;
  tasksDone: number;
  tasksTotal: number;
  makespan: number;
  meanCompletion: number;
  p95Completion: number;
  waitTicks: number;
  maxWait: number;
  fairness: number;
  collisions: number;
  estops: number;
  deadlocks: number;
  reroutes: number;
  energy: number;
  msgs: number;
  avgCluster: number;
  agreement: number;
  wallMs: number;
}

export const MAX_TICKS = 700;

export function familyConfig(family: string, seed: number): SimConfig {
  const common = { seed, orderRate: 0, batteryEnabled: false, crypto: false, urgentShare: 0.12 };
  switch (family) {
    case 'storm':
      return baseConfig({ ...common, layout: 'crossdock', robots: 10, initialOrders: 30, totalOrders: 30 });
    case 'lanes':
      return baseConfig({ ...common, layout: 'narrow', robots: 8, initialOrders: 32, totalOrders: 32 });
    case 'dense':
      return baseConfig({ ...common, layout: 'fulfillment', robots: 12, initialOrders: 48, totalOrders: 48 });
    case 'blocked': {
      const cfg = baseConfig({ ...common, layout: 'fulfillment', robots: 10, initialOrders: 40, totalOrders: 40 });
      const map = buildMap(cfg.layout, cfg.width, cfg.height);
      const midY = Math.floor(map.height / 2) - 1;
      const tl: TimelineEvent[] = [];
      for (const [x, y] of [[8, midY], [9, midY], [8, midY + 1], [9, midY + 1]]) {
        const c = map.idx(x, y);
        if (map.walkable(c)) tl.push({ at: 20, type: 'block', cell: c, duration: 160 });
      }
      cfg.timeline = tl;
      return cfg;
    }
    case 'lossy': {
      const cfg = baseConfig({ ...common, layout: 'fulfillment', robots: 10, initialOrders: 40, totalOrders: 40 });
      cfg.net = { ...cfg.net, packetLoss: 0.15 };
      cfg.timeline = [{ at: 30, type: 'fault', robot: seed % 10, fault: 'blackout', duration: 40 }];
      return cfg;
    }
    default:
      return baseConfig(common);
  }
}

export function runTrial(family: string, seed: number, variantId: string): TrialResult {
  const v = VARIANTS.find((x) => x.id === variantId) ?? VARIANTS[0];
  const cfg = familyConfig(family, seed);
  cfg.planner = v.kind;
  cfg.algo = { ...cfg.algo, ...(v.patch ?? {}) };
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const sim = new Simulation(cfg);
  while (!sim.allDone() && sim.t < MAX_TICKS) sim.step();
  const m = sim.m;
  const done = sim.allDone();
  return {
    family,
    seed,
    variant: v.id,
    ticks: sim.t,
    completed: done,
    tasksDone: m.tasksDone,
    tasksTotal: m.tasksCreated,
    makespan: done ? sim.t : MAX_TICKS,
    meanCompletion: m.meanCompletion,
    p95Completion: m.p95Completion,
    waitTicks: m.waitTicks,
    maxWait: m.maxWait,
    fairness: m.fairness,
    collisions: m.collisions,
    estops: m.estops,
    deadlocks: m.deadlocks,
    reroutes: m.reroutes,
    energy: m.energy,
    msgs: m.msgsSent,
    avgCluster: m.avgCluster,
    agreement: m.agreement,
    wallMs: (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0,
  };
}

export interface Stat {
  mean: number;
  sd: number;
  ci95: number;
  n: number;
}

export function stat(xs: number[]): Stat {
  const n = xs.length;
  if (n === 0) return { mean: 0, sd: 0, ci95: 0, n: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  return { mean, sd, ci95: n > 1 ? (1.96 * sd) / Math.sqrt(n) : 0, n };
}

export interface Summary {
  variant: string;
  trials: number;
  completionRate: number;
  tasksDonePct: number;
  makespan: Stat;
  meanCompletion: Stat;
  waitTicks: Stat;
  maxWait: Stat;
  fairness: Stat;
  collisions: number;
  estops: number;
  deadlocks: number;
  energy: Stat;
}

export function summarize(results: TrialResult[], variant: string): Summary {
  const rs = results.filter((r) => r.variant === variant);
  const sum = (f: (r: TrialResult) => number) => rs.reduce((a, r) => a + f(r), 0);
  return {
    variant,
    trials: rs.length,
    completionRate: rs.length ? rs.filter((r) => r.completed).length / rs.length : 0,
    tasksDonePct: sum((r) => r.tasksTotal) ? sum((r) => r.tasksDone) / sum((r) => r.tasksTotal) : 0,
    makespan: stat(rs.map((r) => r.makespan)),
    meanCompletion: stat(rs.map((r) => r.meanCompletion)),
    waitTicks: stat(rs.map((r) => r.waitTicks)),
    maxWait: stat(rs.map((r) => r.maxWait)),
    fairness: stat(rs.map((r) => r.fairness)),
    collisions: sum((r) => r.collisions),
    estops: sum((r) => r.estops),
    deadlocks: sum((r) => r.deadlocks),
    energy: stat(rs.map((r) => r.energy)),
  };
}

/** Paired improvement of `a` over `b` on a metric (positive = a is better / lower). */
export function pairedImprovement(results: TrialResult[], a: string, b: string, metric: keyof TrialResult): number {
  const byKey = new Map<string, TrialResult>();
  for (const r of results) if (r.variant === b) byKey.set(`${r.family}:${r.seed}`, r);
  let sa = 0;
  let sb = 0;
  for (const r of results) {
    if (r.variant !== a) continue;
    const o = byKey.get(`${r.family}:${r.seed}`);
    if (!o) continue;
    sa += Number(r[metric]);
    sb += Number(o[metric]);
  }
  return sb > 0 ? (sb - sa) / sb : 0;
}
