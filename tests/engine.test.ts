import { describe, expect, it } from 'vitest';
import { AnvayaAgent } from '../src/engine/anvaya';
import { Identity, verifySig, signText } from '../src/engine/crypto';
import { buildMap } from '../src/engine/grid';
import { ReservationTable, distanceField, spaceTimeAStar, spatialPath } from '../src/engine/planning';
import { makeScenario, baseConfig } from '../src/engine/scenarios';
import { Simulation } from '../src/engine/sim';
import { runTrial } from '../src/engine/benchmark';
import type { SimConfig } from '../src/engine/types';

const staBase = (map: ReturnType<typeof buildMap>, start: number, goal: number, rt: ReservationTable) => ({
  map, start, goal, self: 0, horizon: 12, rt, field: distanceField(map, goal, new Set()), blocked: new Set<number>(),
  moveTicks: 1, wDelay: 1, wEnergy: 0.1, wCongestion: 0, wUncertainty: 0, wReplan: 0,
});

describe('planning', () => {
  const map = buildMap('crossdock', 12, 12);
  it('distance field and spatial path agree with Manhattan distance on open floor', () => {
    const a = map.idx(0, 0);
    const b = map.idx(0, 6);
    const p = spatialPath(map, a, b, distanceField(map, b, new Set()))!;
    expect(p.length - 1).toBe(6);
  });
  it('space-time A* waits for a reserved cell instead of entering it', () => {
    const rt = new ReservationTable(map.n, 12);
    const start = map.idx(0, 0);
    const goal = map.idx(0, 2);
    // another robot sits on (0,1) for t = 0..3
    for (let t = 0; t <= 3; t++) rt.reserve(map.idx(0, 1), t, 5);
    const r = spaceTimeAStar(staBase(map, start, goal, rt))!;
    for (let t = 0; t <= 3; t++) expect(r.timed[t]).not.toBe(map.idx(0, 1));
    // headway: cannot enter (0,1) at t=4 either (occupied at t=3)
    expect(r.timed[4]).not.toBe(map.idx(0, 1));
  });
  it('space-time A* never plans a head-on swap', () => {
    const rt = new ReservationTable(map.n, 12);
    const a = map.idx(0, 0);
    const b = map.idx(1, 0);
    rt.reserve(b, 0, 7);
    rt.reserve(a, 1, 7); // peer moves b -> a at t=1
    const r = spaceTimeAStar(staBase(map, a, b, rt))!;
    expect(!(r.timed[0] === a && r.timed[1] === b)).toBe(true);
  });
});

describe('Ed25519 message authentication', () => {
  const id = new Identity(0, 'R1', 'test');
  const evil = new Identity(9, 'EVIL', 'other');
  const text = JSON.stringify({ k: 'HB', from: 0, seq: 1, pos: 12 });
  it('accepts a genuine signature', () => {
    expect(verifySig(id.pk, text, signText(id, text))).toBe(true);
  });
  it('rejects a tampered payload', () => {
    const sig = signText(id, text);
    expect(verifySig(id.pk, text.replace('12', '13'), sig)).toBe(false);
  });
  it('rejects a signature made with another key (impersonation)', () => {
    expect(verifySig(id.pk, text, signText(evil, text))).toBe(false);
  });
});

function run(cfg: SimConfig, ticks: number): Simulation {
  const s = new Simulation(cfg);
  while (s.t < ticks && !(cfg.totalOrders > 0 && s.allDone())) s.step();
  return s;
}

describe('physics & safety invariants', () => {
  it('no physical contact ever, and ANVAYA never needs the Level-1 emergency stop', () => {
    for (const layout of ['fulfillment', 'narrow', 'classic', 'crossdock'] as const) {
      for (const seed of [1, 2, 3]) {
        const cfg = baseConfig({ seed, layout, robots: 10, orderRate: 0, initialOrders: 30, totalOrders: 30, crypto: false, batteryEnabled: false });
        const s = run(cfg, 500);
        expect(s.m.collisions, `${layout}/${seed} contact`).toBe(0);
        expect(s.m.estops, `${layout}/${seed} near-miss`).toBe(0);
        expect(s.allDone(), `${layout}/${seed} all orders delivered`).toBe(true);
      }
    }
  });
  it('the baseline is kept contact-free only by the physical safety field', () => {
    const cfg = baseConfig({ seed: 2, planner: 'baseline', robots: 12, orderRate: 0, initialOrders: 40, totalOrders: 40, crypto: false, batteryEnabled: false });
    const s = run(cfg, 500);
    expect(s.m.collisions).toBe(0);
  });
  it('robots move at most one orthogonal cell per tick and never enter racks', () => {
    const cfg = baseConfig({ seed: 5, robots: 10, orderRate: 4, initialOrders: 10, crypto: false });
    const s = new Simulation(cfg);
    for (let i = 0; i < 200; i++) {
      const before = s.robots.map((r) => r.pos);
      s.step();
      s.robots.forEach((r, j) => {
        expect(s.map.walkable(r.pos)).toBe(true);
        expect(s.map.manhattan(r.pos, before[j])).toBeLessThanOrEqual(1);
      });
      const cells = new Set(s.robots.map((r) => r.pos));
      expect(cells.size).toBe(s.robots.length);
    }
  });
});

describe('physics at scale (48 AMRs)', () => {
  it('never enters racks/pallets, never shares a cell, never swaps, never jumps', async () => {
    const { CellKind } = await import('../src/engine/types');
    const cfg = makeScenario('scale', 7);
    cfg.crypto = false;
    const s = new Simulation(cfg);
    let bad = 0;
    while (s.t < 150) {
      const before = s.robots.map((r) => r.pos);
      s.step();
      const cells = new Set<number>();
      s.robots.forEach((r, i) => {
        if (s.map.kind[r.pos] === CellKind.Rack || s.blocked.has(r.pos)) bad++;
        if (cells.has(r.pos)) bad++;
        cells.add(r.pos);
        if (s.map.manhattan(r.pos, before[i]) > 1) bad++;
        s.robots.forEach((q, j) => {
          if (j > i && r.pos === before[j] && q.pos === before[i] && r.pos !== q.pos) bad++;
        });
      });
    }
    expect(bad).toBe(0);
    expect(s.m.collisions).toBe(0);
    expect(s.m.estops).toBe(0);
    expect(s.m.tasksDone).toBeGreaterThan(20);
  });
});

describe('determinism', () => {
  it('same seed ⇒ identical outcome (nothing random outside the seed)', () => {
    const a = runTrial('dense', 3, 'anvaya');
    const b = runTrial('dense', 3, 'anvaya');
    expect({ ...a, wallMs: 0 }).toEqual({ ...b, wallMs: 0 });
  });
});

describe('resilience behaviours (emergent, not scripted)', () => {
  it('unknown ≠ free: a silent robot’s cells become protected in its peers’ reservation tables', () => {
    const cfg = baseConfig({ seed: 7, robots: 8, orderRate: 3, initialOrders: 10, crypto: true });
    cfg.timeline = [{ at: 20, type: 'fault', robot: 2, fault: 'blackout', duration: 30 }];
    const s = new Simulation(cfg);
    while (s.t < 30) s.step();
    const silent = s.robots[2].pos;
    const protectedBy = s.agents.filter((a, i) => i !== 2 && a instanceof AnvayaAgent && a.debug.protectedCells.includes(silent));
    expect(protectedBy.length).toBeGreaterThan(0);
    expect(s.m.collisions).toBe(0);
  });
  it('a compromised robot is isolated by peers and quarantined; forged and replayed messages are rejected', () => {
    const cfg = makeScenario('rogue', 7);
    const s = run(cfg, 100);
    const r5 = s.robots[4];
    const isolators = s.agents.filter((a) => a instanceof AnvayaAgent && a.isolating().includes(4));
    expect(isolators.length).toBeGreaterThanOrEqual(5);
    expect(r5.quarantined).toBe(true);
    expect(s.log.some((l) => l.text.includes('forged message'))).toBe(true);
    expect(s.log.some((l) => l.text.includes('replayed message'))).toBe(true);
    expect(s.m.collisions).toBe(0);
  });
  it('a degraded drive is detected by the robot itself (plan vs reality)', () => {
    const s = run(makeScenario('degraded', 7), 80);
    expect(s.log.some((l) => l.text.includes('R4 self-diagnosis'))).toBe(true);
  });
  it('a blocked aisle is discovered by lidar and gossiped over the mesh', () => {
    const s = run(makeScenario('blocked', 7), 90);
    const blockedCell = Array.from(s.blocked)[0];
    const knowers = s.agents.filter((a) => a.blocked.has(blockedCell));
    expect(knowers.length).toBeGreaterThan(1);
  });
  it('independent traffic is not coordinated (coordination scope stays 1)', () => {
    const s = run(makeScenario('parallel', 7), 200);
    expect(s.m.avgCluster).toBeLessThan(1.1);
    expect(s.allDone()).toBe(true);
  });
});

describe('decentralised auction', () => {
  it('every order is delivered exactly once', () => {
    const cfg = baseConfig({ seed: 11, robots: 10, orderRate: 0, initialOrders: 30, totalOrders: 30, crypto: false, batteryEnabled: false });
    const s = run(cfg, 600);
    expect(s.allDone()).toBe(true);
    expect(s.m.tasksDone).toBe(30);
  });
});
