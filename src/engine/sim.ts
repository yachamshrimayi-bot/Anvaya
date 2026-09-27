import { AgentBase, AgentEvent, Decision, Sense } from './agentBase';
import { AnvayaAgent } from './anvaya';
import { BaselineAgent } from './baseline';
import { Identity, Registry, signText } from './crypto';
import { WarehouseMap, buildMap } from './grid';
import { Envelope, OrderMsg, WMS_ID, encode } from './messages';
import { MeshNetwork } from './network';
import { resetPlanningCaches } from './planning';
import { Rng } from './rng';
import type { Action, Cell, FaultKind, Priority, SimConfig, Task, TimelineEvent } from './types';
import { CellKind } from './types';

export interface RobotTruth {
  id: number;
  name: string;
  pos: Cell;
  prev: Cell;
  heading: number;
  battery: number;
  carrying: string | null;
  faults: { blackoutUntil: number; slow: boolean; motor: boolean; rogue: boolean };
  slowCooldown: boolean;
  quarantined: boolean;
  lastMoveOk: boolean;
  estopped: boolean;
  pickResult: 'ok' | 'empty' | null;
  action: Action;
  reason: string;
  yieldTo: number;
  plan: Cell[];
  progressT: number;
  bestDist: number;
  trackGoal: number;
  deadlocked: boolean;
  odometer: number;
  turns: number;
}

export interface LogEntry extends AgentEvent {
  t: number;
  count: number;
}

export interface Metrics {
  t: number;
  tasksCreated: number;
  tasksDone: number;
  throughputPer100: number;
  meanCompletion: number;
  p95Completion: number;
  collisions: number;
  estops: number;
  deadlocks: number;
  waitTicks: number;
  moveTicks: number;
  reroutes: number;
  yields: number;
  safetyHolds: number;
  maxWait: number;
  fairness: number; // Jain index over per-robot waiting
  energy: number;
  msgsSent: number;
  msgsDropped: number;
  securityRejects: number;
  isolations: number;
  avgCluster: number;
  agreement: number;
  wastedTrips: number;
  thinkMsAvg: number;
}

const DEADLOCK_TICKS = 30;

export function defaultOrdersSeeded(map: WarehouseMap, rng: Rng, urgentShare: number): { pickup: Cell; drop: Cell; priority: Priority } {
  const pickup = rng.pick(map.pickFaces);
  const drop = rng.pick(map.drops.length ? map.drops : map.pickFaces);
  const r = rng.next();
  const priority: Priority = r < urgentShare ? 'URGENT' : r < urgentShare + 0.2 ? 'HIGH' : r < urgentShare + 0.8 ? 'NORMAL' : 'LOW';
  return { pickup, drop, priority };
}

/**
 * The digital twin: ground-truth physics + the P2P mesh + N independent robot
 * controllers. The simulator never makes a coordination decision; it only moves
 * bodies, delivers radio packets and measures outcomes.
 */
export class Simulation {
  readonly cfg: SimConfig;
  readonly map: WarehouseMap;
  readonly net: MeshNetwork;
  readonly agents: AgentBase[];
  readonly robots: RobotTruth[];
  readonly tasks = new Map<string, Task>();
  readonly blocked = new Set<Cell>();
  readonly blockUntil = new Map<Cell, number>();
  readonly log: LogEntry[] = [];
  readonly registry = new Registry();
  readonly wms: Identity;
  readonly identities: Identity[] = [];
  captions: { t: number; text: string; focus?: Cell }[] = [];
  t = 0;
  private rng: Rng;
  private orderRng: Rng;
  private inboxes = new Map<number, Envelope[]>();
  private wmsSeq = 0;
  private orderCount = 0;
  private timeline: TimelineEvent[];
  private captured = new Map<number, Envelope>();
  private collisionPairs = new Set<string>();
  private thinkMsSum = 0;
  private thinkMsN = 0;
  m: Metrics;
  history: { t: number; done: number; wait: number; collisions: number; throughput: number }[] = [];
  lastDecisions: Decision[] = [];

  constructor(cfg: SimConfig) {
    this.cfg = structuredClone(cfg);
    // Commitment lead must cover the radio latency (see gate proof in anvaya.ts).
    this.cfg.algo.commitLead = Math.max(1, this.cfg.net.latency | 0);
    resetPlanningCaches();
    this.rng = new Rng(cfg.seed);
    this.orderRng = new Rng(cfg.seed * 7919 + 17);
    this.map = buildMap(cfg.layout, cfg.width, cfg.height, cfg.customRacks);
    this.net = new MeshNetwork(this.map, this.cfg.net, cfg.deadZones, cfg.seed);
    this.timeline = (cfg.timeline ?? []).slice().sort((a, b) => a.at - b.at);
    this.wms = new Identity(WMS_ID, 'WMS', cfg.seed);
    this.registry.enroll(WMS_ID, this.wms.pk);

    const starts = this.pickStarts(cfg.robots);
    const ids = starts.map((_, i) => i);
    this.robots = [];
    this.agents = [];
    for (let i = 0; i < starts.length; i++) {
      const idn = new Identity(i, `R${i + 1}`, cfg.seed);
      this.identities.push(idn);
      this.registry.enroll(i, idn.pk);
    }
    for (let i = 0; i < starts.length; i++) {
      const home = starts[i];
      const agent =
        cfg.planner === 'anvaya'
          ? new AnvayaAgent(i, this.map, home, this.cfg.algo, this.identities[i], this.registry, ids, cfg.crypto)
          : new BaselineAgent(i, this.map, home, this.cfg.algo);
      agent.battery = cfg.batteryEnabled ? 60 + this.rng.int(40) : 100;
      this.agents.push(agent);
      this.robots.push({
        id: i,
        name: `R${i + 1}`,
        pos: home,
        prev: home,
        heading: 0,
        battery: agent.battery,
        carrying: null,
        faults: { blackoutUntil: -1, slow: false, motor: false, rogue: false },
        slowCooldown: false,
        quarantined: false,
        lastMoveOk: true,
        estopped: false,
        pickResult: null,
        action: 'WAIT',
        reason: 'Booting',
        yieldTo: -1,
        plan: [home],
        progressT: 0,
        bestDist: 1e9,
        trackGoal: -1,
        deadlocked: false,
        odometer: 0,
        turns: 0,
      });
    }
    this.m = this.emptyMetrics();
    // initial batch
    const initial = cfg.orders ?? [];
    for (const o of initial) this.timeline.push({ at: o.at, type: 'order', pickup: o.pickup, drop: o.drop, priority: o.priority });
    this.timeline.sort((a, b) => a.at - b.at);
    if (!cfg.orders) for (let i = 0; i < cfg.initialOrders; i++) this.releaseOrder();
  }

  private emptyMetrics(): Metrics {
    return {
      t: 0, tasksCreated: 0, tasksDone: 0, throughputPer100: 0, meanCompletion: 0, p95Completion: 0, collisions: 0, estops: 0,
      deadlocks: 0, waitTicks: 0, moveTicks: 0, reroutes: 0, yields: 0, safetyHolds: 0, maxWait: 0, fairness: 1, energy: 0,
      msgsSent: 0, msgsDropped: 0, securityRejects: 0, isolations: 0, avgCluster: 1, agreement: 1, wastedTrips: 0, thinkMsAvg: 0,
    };
  }

  private pickStarts(n: number): Cell[] {
    if (this.cfg.starts && this.cfg.starts.length >= n) return this.cfg.starts.slice(0, n).filter((c) => this.map.walkable(c));
    const homes = this.map.homes.slice();
    const out: Cell[] = [];
    // spread robots across home bays deterministically
    const step = Math.max(1, Math.floor(homes.length / Math.max(1, n)));
    for (let i = 0; i < homes.length && out.length < n; i += step) out.push(homes[i]);
    for (const h of homes) if (out.length < n && !out.includes(h)) out.push(h);
    if (out.length < n) {
      const floor: Cell[] = [];
      for (let c = 0; c < this.map.n; c++) if (this.map.kind[c] === CellKind.Floor && !this.map.pickFaces.includes(c)) floor.push(c);
      this.rng.shuffle(floor);
      for (const c of floor) if (out.length < n && !out.includes(c)) out.push(c);
    }
    return out.slice(0, n);
  }

  // ------------------------------------------------------------------ orders
  releaseOrder(spec?: { pickup: Cell; drop: Cell; priority: Priority }): Task | null {
    if (this.cfg.totalOrders > 0 && this.orderCount >= this.cfg.totalOrders && !spec) return null;
    const o = spec ?? defaultOrdersSeeded(this.map, this.orderRng, this.cfg.urgentShare);
    if (!this.map.walkable(o.pickup) || !this.map.walkable(o.drop)) return null;
    this.orderCount++;
    const id = `T${String(this.orderCount).padStart(3, '0')}`;
    const task: Task = { id, pickup: o.pickup, drop: o.drop, priority: o.priority, createdAt: this.t, assignedTo: null, pickedAt: null, doneAt: null, epoch: 0 };
    this.tasks.set(id, task);
    this.m.tasksCreated++;
    this.announce(task);
    return task;
  }

  private announce(task: Task): void {
    const msg: OrderMsg = { k: 'ORDER', from: WMS_ID, seq: ++this.wmsSeq, t: this.t, id: task.id, pickup: task.pickup, drop: task.drop, prio: task.priority, at: task.createdAt };
    const text = encode(msg);
    const env: Envelope = { from: WMS_ID, text, sig: this.cfg.crypto ? signText(this.wms, text) : null, sentAt: this.t, origin: -1, tag: 'order' };
    this.net.broadcast(env, -1, this.positions(), this.t);
  }

  /** Live network change from the workbench: keeps the commitment lead in step with latency. */
  setNetwork(p: Partial<import('./types').NetworkParams>): void {
    Object.assign(this.net.params, p);
    Object.assign(this.cfg.net, p);
    this.cfg.algo.commitLead = Math.max(1, this.cfg.net.latency | 0);
  }

  private positions(): Map<number, Cell> {
    const m = new Map<number, Cell>();
    for (const r of this.robots) m.set(r.id, r.pos);
    return m;
  }

  // ------------------------------------------------------------------ faults
  injectFault(robot: number, fault: FaultKind, duration?: number): void {
    const r = this.robots[robot];
    if (!r) return;
    const a = this.agents[robot];
    const until = duration ? this.t + duration : 1e9;
    if (fault === 'heal') {
      r.faults = { blackoutUntil: -1, slow: false, motor: false, rogue: false };
      r.quarantined = false;
      this.net.radioOff.delete(robot);
      if (a instanceof AnvayaAgent) a.compromised = false;
      this.push({ kind: 'fault', text: `Operator: ${r.name} repaired`, robot, cell: r.pos, t: this.t, count: 1 });
      return;
    }
    if (fault === 'blackout') {
      r.faults.blackoutUntil = until;
      this.net.radioOff.add(robot);
    }
    if (fault === 'slowdown') r.faults.slow = true;
    if (fault === 'motor') r.faults.motor = true;
    if (fault === 'rogue') {
      r.faults.rogue = true;
      if (a instanceof AnvayaAgent) a.compromised = true;
    }
    const label: Record<FaultKind, string> = {
      blackout: 'radio blackout',
      slowdown: 'motor degradation (half speed, unreported)',
      motor: 'drive failure',
      rogue: 'firmware compromised (valid key, forged content)',
      heal: 'repaired',
    };
    this.push({ kind: 'fault', text: `⚡ Injected on ${r.name}: ${label[fault]}${duration ? ` for ${duration} ticks` : ''}`, robot, cell: r.pos, t: this.t, count: 1 });
  }

  toggleBlock(cell: Cell, duration?: number): boolean {
    if (!this.map.walkable(cell)) return false;
    if (this.blocked.has(cell)) {
      this.blocked.delete(cell);
      this.blockUntil.delete(cell);
      this.push({ kind: 'info', text: `Aisle cleared at ${this.map.label(cell)}`, robot: -1, cell, t: this.t, count: 1 });
      return false;
    }
    if (this.robots.some((r) => r.pos === cell)) return false;
    this.blocked.add(cell);
    if (duration) this.blockUntil.set(cell, this.t + duration);
    this.push({ kind: 'info', text: `⚠ Aisle blocked at ${this.map.label(cell)} (pallet dropped) — robots must discover it with lidar`, robot: -1, cell, t: this.t, count: 1 });
    return true;
  }

  /** An attacker without the key impersonates a robot: signature will not verify. */
  spoof(target: number): void {
    const r = this.robots[target];
    if (!r) return;
    const fake = { k: 'HB', from: target, seq: 1e9, t: this.t, pos: this.map.junctions[0] ?? r.pos, goal: r.pos, mode: 'TO_PICKUP', prio: 'URGENT', task: null, epoch: 99, bid: 0, wait: 999, mv: 1, plan: [r.pos], bids: [], done: [], rel: [], blk: [], clr: [], chg: -1, iso: [], health: 'OK', batt: 100, svc: 0, prec: [] };
    const text = JSON.stringify(fake);
    const attacker = new Identity(-7, 'ATTACKER', 'evil');
    const env: Envelope = { from: target, text, sig: signText(attacker, text), sentAt: this.t, origin: -1, tag: 'forged' };
    this.net.broadcast(env, -1, this.positions(), this.t);
    this.push({ kind: 'security', text: `☠ Attacker broadcasts forged heartbeat impersonating ${r.name} (wrong private key)`, robot: -1, t: this.t, count: 1 });
  }

  replay(target: number): void {
    const env = this.captured.get(target);
    if (!env) return;
    this.net.broadcast({ ...env, sentAt: this.t, tag: 'replay' }, -1, this.positions(), this.t);
    this.push({ kind: 'security', text: `☠ Attacker replays a captured (validly signed) message from R${target + 1}`, robot: -1, t: this.t, count: 1 });
  }

  // ------------------------------------------------------------------ logging
  private push(e: LogEntry): void {
    this.log.push(e);
    if (this.log.length > 600) this.log.splice(0, this.log.length - 600);
  }

  private absorbEvents(events: AgentEvent[]): void {
    const seen = new Map<string, LogEntry>();
    for (const e of events) {
      if (e.key) {
        const prev = seen.get(e.key) ?? this.log.slice(-40).find((l) => l.key === e.key);
        if (prev) {
          prev.count++;
          continue;
        }
      }
      const le: LogEntry = { ...e, t: this.t, count: 1 };
      if (e.key) seen.set(e.key, le);
      this.push(le);
      if (e.kind === 'security') this.m.securityRejects++;
      if (e.kind === 'trust' && e.text.includes('isolates')) this.m.isolations++;
    }
  }

  // ------------------------------------------------------------------ physics
  private sense(r: RobotTruth): Sense {
    const lidarCells: Cell[] = [];
    const lidarBlocked: Cell[] = [];
    const x = this.map.x(r.pos);
    const y = this.map.y(r.pos);
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        if (Math.abs(dx) + Math.abs(dy) > 2) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (!this.map.inBounds(nx, ny)) continue;
        const c = this.map.idx(nx, ny);
        if (!this.map.walkable(c)) continue;
        lidarCells.push(c);
        if (this.blocked.has(c)) lidarBlocked.push(c);
      }
    const lidarRobots: { id: number; cell: Cell }[] = [];
    for (const o of this.robots) if (o.id !== r.id && this.map.manhattan(o.pos, r.pos) <= 2) lidarRobots.push({ id: o.id, cell: o.pos });
    return {
      t: this.t,
      pos: r.pos,
      heading: r.heading,
      moved: r.lastMoveOk,
      estopped: r.estopped,
      driveFault: r.faults.motor,
      quarantined: r.quarantined,
      battery: r.battery,
      lidarRobots,
      lidarCells,
      lidarBlocked,
      pickResult: r.pickResult,
      radioUp: this.net.canTransmit(r.id, r.pos),
    };
  }

  private runTimeline(): void {
    while (this.timeline.length && this.timeline[0].at <= this.t) {
      const ev = this.timeline.shift()!;
      switch (ev.type) {
        case 'fault':
          this.injectFault(ev.robot, ev.fault, ev.duration);
          break;
        case 'block':
          if (!this.blocked.has(ev.cell)) this.toggleBlock(ev.cell, ev.duration);
          break;
        case 'unblock':
          if (this.blocked.has(ev.cell)) this.toggleBlock(ev.cell);
          break;
        case 'order':
          this.releaseOrder({ pickup: ev.pickup, drop: ev.drop, priority: ev.priority });
          break;
        case 'spoof':
          this.spoof(ev.target);
          break;
        case 'replay':
          this.replay(ev.target);
          break;
        case 'caption':
          this.captions.push({ t: this.t, text: ev.text, focus: ev.focus });
          break;
      }
    }
  }

  step(): void {
    this.t++;
    this.net.beginTick();
    this.runTimeline();

    // Timed fault expiry and block expiry.
    for (const r of this.robots) {
      if (r.faults.blackoutUntil >= 0 && this.t >= r.faults.blackoutUntil) {
        r.faults.blackoutUntil = -1;
        this.net.radioOff.delete(r.id);
        this.push({ kind: 'fault', text: `${r.name} radio restored — re-syncing with peers`, robot: r.id, cell: r.pos, t: this.t, count: 1 });
      }
    }
    for (const [c, until] of this.blockUntil) if (this.t >= until) this.toggleBlock(c);

    // Continuous order stream (Poisson-like, seeded).
    if (this.cfg.orderRate > 0 && this.orderRng.chance(this.cfg.orderRate / 100)) this.releaseOrder();
    // WMS re-announces open orders (robots in dead zones may have missed them).
    if (this.t % 10 === 0) for (const task of this.tasks.values()) if (task.pickedAt === null && task.doneAt === null) this.announce(task);

    // Radio delivery.
    this.inboxes = this.net.deliver(this.t, this.positions());

    // Safety supervisor: peers' isolation votes can physically stop a robot.
    if (this.cfg.planner === 'anvaya') {
      const active = this.agents.filter((a) => a.mode !== 'FAULT').length;
      const need = Math.max(2, Math.ceil((active - 1) / 2));
      for (const r of this.robots) {
        let votes = 0;
        for (const a of this.agents) if (a.id !== r.id && a instanceof AnvayaAgent && a.isolating().includes(r.id)) votes++;
        const q = votes >= need;
        if (q && !r.quarantined) this.push({ kind: 'safety', text: `🛑 ${r.name} quarantined: ${votes} peers voted it untrusted — onboard safety PLC stops the drive`, robot: r.id, cell: r.pos, t: this.t, count: 1 });
        r.quarantined = q || (r.quarantined && r.faults.rogue);
      }
    }

    // Each robot thinks independently.
    const decisions: Decision[] = new Array(this.agents.length);
    const allEvents: AgentEvent[] = [];
    for (let i = 0; i < this.agents.length; i++) {
      const r = this.robots[i];
      const s = this.sense(r);
      r.pickResult = null;
      const d = this.agents[i].think(this.t, this.inboxes.get(i) ?? [], s);
      decisions[i] = d;
      for (const e of d.events) allEvents.push(e);
      const a = this.agents[i];
      if (a instanceof AnvayaAgent) {
        this.thinkMsSum += a.debug.thinkMs;
        this.thinkMsN++;
      }
    }
    this.lastDecisions = decisions;
    this.absorbEvents(allEvents);

    // Physics: resolve simultaneous motion.
    const intent = new Map<number, Cell>();
    for (let i = 0; i < this.robots.length; i++) {
      const r = this.robots[i];
      let target = decisions[i].next;
      r.estopped = false;
      if (!this.map.walkable(target) || this.blocked.has(target) || (target !== r.pos && !this.map.adjacent(target, r.pos))) target = r.pos;
      if (r.faults.motor || r.quarantined || r.battery <= 0) target = r.pos;
      if (target !== r.pos && r.faults.slow) {
        if (r.slowCooldown) target = r.pos;
      }
      intent.set(i, target);
    }
    // ---- Level-1 onboard safety field (present on every robot, whatever its planner).
    // A robot's safety-rated lidar brakes it before it can touch another body:
    //   (a) driving into a cell that stays occupied,
    //   (b) two robots converging on the same free cell (both brake),
    //   (c) two robots driving through each other (head-on swap; both brake).
    // Iterate to a fixed point, since one brake can turn another move into case (a).
    const estop = (i: number, why: string, cell: Cell, other: number) => {
      const r = this.robots[i];
      if (intent.get(i) === r.pos) return;
      intent.set(i, r.pos);
      r.estopped = true;
      this.m.estops++;
      const key = `estop:${Math.min(i, other)}-${Math.max(i, other)}:${this.t}`;
      if (!this.log.slice(-20).some((l) => l.key === key)) {
        this.push({ kind: 'safety', text: `🛑 Near-miss: ${r.name} emergency-braked (${why}) at ${this.map.label(cell)} — Level-1 safety field`, robot: i, cell, t: this.t, count: 1, key });
      }
    };
    for (let guard = 0; guard < 64; guard++) {
      let changed = false;
      const occupiedAfter = new Map<Cell, number>();
      for (const [i, tgt] of intent) if (tgt === this.robots[i].pos) occupiedAfter.set(tgt, i);
      for (const [i, tgt] of intent) {
        const r = this.robots[i];
        if (tgt === r.pos) continue;
        const stayer = occupiedAfter.get(tgt);
        if (stayer !== undefined) {
          estop(i, `R${stayer + 1} ahead did not move`, tgt, stayer);
          changed = true;
        }
      }
      const entering = new Map<Cell, number[]>();
      for (const [i, tgt] of intent) if (tgt !== this.robots[i].pos) (entering.get(tgt) ?? entering.set(tgt, []).get(tgt)!).push(i);
      for (const [cell, ids] of entering) {
        if (ids.length < 2) continue;
        for (const i of ids) estop(i, `converging with ${ids.filter((j) => j !== i).map((j) => `R${j + 1}`).join(', ')}`, cell, ids.find((j) => j !== i)!);
        changed = true;
      }
      for (const [i, tgt] of intent) {
        const r = this.robots[i];
        if (tgt === r.pos) continue;
        for (const [j, tgt2] of intent) {
          if (j <= i) continue;
          const q = this.robots[j];
          if (tgt === q.pos && tgt2 === r.pos) {
            estop(i, `head-on with R${j + 1}`, tgt, j);
            estop(j, `head-on with R${i + 1}`, tgt2, i);
            changed = true;
          }
        }
      }
      if (!changed) break;
    }
    // Physical invariant: after motion no two bodies share a cell and none passed through another.
    {
      const seen = new Map<Cell, number>();
      for (const [i, tgt] of intent) {
        const o = seen.get(tgt);
        if (o !== undefined) this.recordCollision([o, i], tgt);
        seen.set(tgt, i);
      }
      for (const [i, tgt] of intent) {
        for (const [j, tgt2] of intent) {
          if (j <= i) continue;
          if (tgt !== this.robots[i].pos && tgt === this.robots[j].pos && tgt2 === this.robots[i].pos) this.recordCollision([i, j], tgt);
        }
      }
    }

    // Apply motion, energy, battery.
    for (let i = 0; i < this.robots.length; i++) {
      const r = this.robots[i];
      const d = decisions[i];
      const tgt = intent.get(i)!;
      const commanded = d.next !== r.pos;
      r.prev = r.pos;
      if (tgt !== r.pos) {
        const dx = this.map.x(tgt) - this.map.x(r.pos);
        const dy = this.map.y(tgt) - this.map.y(r.pos);
        const h = Math.atan2(dy, dx);
        if (Math.abs(h - r.heading) > 0.01) r.turns++;
        r.heading = h;
        r.pos = tgt;
        r.odometer++;
        this.m.moveTicks++;
        this.m.energy += 1;
        if (r.faults.slow) r.slowCooldown = true;
      } else {
        if (r.faults.slow) r.slowCooldown = false;
        this.m.energy += 0.2;
      }
      r.lastMoveOk = !commanded || tgt !== r.prev;
      if (this.cfg.batteryEnabled) {
        const a = this.agents[i];
        if (a.mode === 'CHARGING' && this.map.kind[r.pos] === CellKind.Charger) r.battery = Math.min(100, r.battery + 1.6);
        else r.battery = Math.max(0, r.battery - (tgt !== r.prev ? 0.12 : 0.02));
      }
      r.action = d.action;
      r.reason = d.reason;
      r.yieldTo = d.yieldTo;
      r.plan = d.plan;

      // Pick / drop requests against ground truth.
      if (d.request) {
        const task = this.tasks.get(d.request.task);
        if (d.request.type === 'pick') {
          if (task && task.pickedAt === null && r.pos === task.pickup) {
            task.pickedAt = this.t;
            task.assignedTo = i;
            r.carrying = task.id;
            r.pickResult = 'ok';
          } else {
            r.pickResult = 'empty';
            this.m.wastedTrips++;
          }
        } else if (d.request.type === 'drop' && task && r.carrying === task.id) {
          task.doneAt = this.t;
          r.carrying = null;
          this.m.tasksDone++;
        }
      }
    }

    // Radio transmit (after motion; origin = where the robot was when it decided).
    for (let i = 0; i < this.agents.length; i++) {
      const r = this.robots[i];
      for (const env of decisions[i].envelopes) {
        env.origin = r.prev;
        this.net.broadcast(env, i, this.positions(), this.t);
        if (this.t % 25 === 0) this.captured.set(i, env);
      }
    }

    this.updateMetrics(decisions);
  }

  private recordCollision(ids: number[], cell: Cell): void {
    const key = `${ids.slice().sort().join('-')}@${this.t}`;
    if (this.collisionPairs.has(key)) return;
    this.collisionPairs.add(key);
    this.m.collisions++;
    this.push({ kind: 'safety', text: `💥 PHYSICAL CONTACT between ${ids.map((i) => `R${i + 1}`).join(' & ')} at ${this.map.label(cell)} (invariant violated)`, robot: ids[0], cell, t: this.t, count: 1 });
  }

  private updateMetrics(decisions: Decision[]): void {
    const m = this.m;
    m.t = this.t;
    let waitNow = 0;
    for (let i = 0; i < this.robots.length; i++) {
      const r = this.robots[i];
      const a = this.agents[i];
      const moving = r.pos !== r.prev;
      const hasGoal = a.goal !== r.pos && !a.immovable() && a.mode !== 'IDLE';
      if (hasGoal && !moving) waitNow++;
      // Deadlock / livelock detector (ground truth): a robot with a goal that gets
      // no closer to it for DEADLOCK_TICKS (moving back and forth does not count).
      const d = this.map.manhattan(r.pos, a.goal);
      if (!hasGoal || a.goal !== r.trackGoal) {
        r.trackGoal = a.goal;
        r.bestDist = d;
        r.progressT = this.t;
        r.deadlocked = false;
      } else if (d < r.bestDist) {
        r.bestDist = d;
        r.progressT = this.t;
        r.deadlocked = false;
      }
      if (hasGoal && this.t - r.progressT > DEADLOCK_TICKS && !r.deadlocked && !r.faults.motor && !r.quarantined && r.faults.blackoutUntil < 0) {
        r.deadlocked = true;
        m.deadlocks++;
        this.push({ kind: 'safety', text: `⛔ ${r.name} made no progress for ${DEADLOCK_TICKS} ticks (deadlock / livelock)`, robot: i, cell: r.pos, t: this.t, count: 1 });
      }
    }
    m.waitTicks += waitNow;

    let reroutes = 0;
    let yields = 0;
    let holds = 0;
    let clusterSum = 0;
    let clusterN = 0;
    let agree = 0;
    let agreeN = 0;
    const waits: number[] = [];
    for (const a of this.agents) {
      const s = (a as AnvayaAgent | BaselineAgent).stats;
      reroutes += s.reroutes;
      yields += s.yields;
      holds += s.safetyHolds;
      if (a instanceof AnvayaAgent) {
        clusterSum += a.stats.clusterSum;
        clusterN += a.stats.clusterN;
        agree += a.stats.agreement;
        agreeN += a.stats.agreementN;
      }
      waits.push(a.totalWait);
    }
    m.reroutes = reroutes;
    m.yields = yields;
    m.safetyHolds = holds;
    m.avgCluster = clusterN ? clusterSum / clusterN : 1;
    m.agreement = agreeN ? agree / agreeN : 1;
    m.maxWait = Math.max(0, ...waits);
    const sum = waits.reduce((x, y) => x + y, 0);
    const sq = waits.reduce((x, y) => x + y * y, 0);
    m.fairness = sq > 0 ? (sum * sum) / (waits.length * sq) : 1;
    m.msgsSent = this.net.stats.sent;
    m.msgsDropped = this.net.stats.dropped + this.net.stats.deadZone;
    m.thinkMsAvg = this.thinkMsN ? this.thinkMsSum / this.thinkMsN : 0;

    const done = Array.from(this.tasks.values()).filter((t) => t.doneAt !== null);
    const times = done.map((t) => (t.doneAt as number) - t.createdAt).sort((a, b) => a - b);
    m.meanCompletion = times.length ? times.reduce((a, b) => a + b, 0) / times.length : 0;
    m.p95Completion = times.length ? times[Math.min(times.length - 1, Math.floor(times.length * 0.95))] : 0;
    m.throughputPer100 = this.t > 0 ? (m.tasksDone / this.t) * 100 : 0;

    if (this.t % 5 === 0) {
      this.history.push({ t: this.t, done: m.tasksDone, wait: m.waitTicks, collisions: m.collisions, throughput: m.throughputPer100 });
      if (this.history.length > 400) this.history.shift();
    }
    void decisions;
  }

  allDone(): boolean {
    if (this.cfg.totalOrders <= 0) return false;
    if (this.orderCount < this.cfg.totalOrders) return false;
    for (const t of this.tasks.values()) if (t.doneAt === null) return false;
    return true;
  }
}
