import type { WarehouseMap } from './grid';
import type { Envelope, Heartbeat, OrderMsg } from './messages';
import { WMS_ID } from './messages';
import { INF, blockedKey, distanceField } from './planning';
import type { Action, AlgorithmParams, Cell, Priority, RobotMode } from './types';
import { PRIORITY_WEIGHT } from './types';

/** What a robot's own sensors report this tick (local, physical, no network). */
export interface Sense {
  t: number;
  pos: Cell;
  heading: number;
  /** Did last tick's commanded move physically happen? */
  moved: boolean;
  /** Was last tick's move cancelled by the onboard Level-1 lidar stop? */
  estopped: boolean;
  /** Motor controller fault code present (drive failure). */
  driveFault: boolean;
  /** Onboard safety supervisor has quarantined this robot. */
  quarantined: boolean;
  battery: number;
  /** Robots detected by lidar within radius 2 (id readable via fiducial / UWB tag). */
  lidarRobots: { id: number; cell: Cell }[];
  /** Cells within lidar radius, and which of them hold unexpected obstacles. */
  lidarCells: Cell[];
  lidarBlocked: Cell[];
  /** Result of the last pick request. */
  pickResult: 'ok' | 'empty' | null;
  /** Radio link is up (can hear beacons). */
  radioUp: boolean;
}

export interface AgentEvent {
  kind: 'decision' | 'yield' | 'reroute' | 'trust' | 'security' | 'task' | 'fault' | 'safety' | 'info';
  text: string;
  cell?: Cell;
  key?: string;
  robot: number;
}

export interface Decision {
  next: Cell;
  action: Action;
  reason: string;
  yieldTo: number;
  plan: Cell[];
  envelopes: Envelope[];
  events: AgentEvent[];
  request: { type: 'pick' | 'drop'; task: string } | null;
}

export interface TaskRec {
  id: string;
  pickup: Cell;
  drop: Cell;
  prio: Priority;
  at: number;
  status: 'open' | 'assigned' | 'done';
  owner: number;
  epoch: number;
  bid: number;
  closedAt: number;
}

export const AUCTION_WINDOW = 3;
export const SERVICE_TICKS = 2;
export const LOW_BATTERY = 22;

/**
 * Behaviour shared by every robot controller: mission state machine, battery,
 * the decentralised task auction (Choi et al. 2009-style consensus auction) and
 * obstacle knowledge. Coordination (how to move around peers) is left to the
 * concrete controller: ANVAYA or the stop-and-wait baseline.
 */
export abstract class AgentBase {
  readonly id: number;
  readonly name: string;
  readonly map: WarehouseMap;
  readonly home: Cell;
  algo: AlgorithmParams;

  mode: RobotMode = 'IDLE';
  goal: Cell;
  pos: Cell;
  battery = 100;
  task: TaskRec | null = null;
  serviceLeft = 0;
  waitAge = 0;
  totalWait = 0;
  seq = 0;
  moveTicks = 1;
  chargerClaim: Cell = -1;
  awaitingPick = false;

  readonly tasks = new Map<string, TaskRec>();
  readonly blocked = new Set<Cell>();
  protected bKey = '';
  protected recentDone: { id: string; until: number }[] = [];
  protected recentRelease: { id: string; until: number }[] = [];
  protected newlyBlocked: Cell[] = [];
  protected newlyCleared: Cell[] = [];
  /** Cells recently confirmed clear — ignore stale "blocked" gossip about them. */
  protected clearedUntil = new Map<Cell, number>();
  events: AgentEvent[] = [];
  t = 0;

  constructor(id: number, map: WarehouseMap, home: Cell, algo: AlgorithmParams) {
    this.id = id;
    this.name = `R${id + 1}`;
    this.map = map;
    this.home = home;
    this.goal = home;
    this.pos = home;
    this.algo = algo;
  }

  abstract think(t: number, inbox: Envelope[], sense: Sense): Decision;

  // ------------------------------------------------------------------ helpers
  protected field(goal: Cell): Int32Array {
    return distanceField(this.map, goal, this.blocked, this.bKey);
  }
  protected dist(a: Cell, b: Cell): number {
    const d = this.field(b)[a];
    return d >= INF ? INF : d;
  }
  protected ev(kind: AgentEvent['kind'], text: string, cell?: Cell, key?: string): void {
    this.events.push({ kind, text, cell, key, robot: this.id });
  }
  get weight(): number {
    return this.task ? PRIORITY_WEIGHT[this.task.prio] : 0.25;
  }
  isFree(): boolean {
    return (this.mode === 'IDLE' || this.mode === 'HOMING') && !this.task && this.battery >= LOW_BATTERY + 3;
  }
  /** Remaining ticks this robot will stay put (servicing / charging); -1 = indefinite. */
  serviceRemaining(): number {
    if (this.mode === 'PICKING' || this.mode === 'DROPPING') return this.serviceLeft + 1;
    if (this.mode === 'CHARGING') return Math.ceil(Math.max(0, 95 - this.battery) / 1.6) + 1;
    if (this.mode === 'FAULT') return -1;
    return 0;
  }
  /** How long I will occupy my current goal after reaching it. */
  goalHoldFor(mode: string, horizon: number): number {
    if (mode === 'TO_PICKUP' || mode === 'TO_DROP') return SERVICE_TICKS + 2;
    return horizon;
  }
  immovable(): boolean {
    return this.mode === 'PICKING' || this.mode === 'DROPPING' || this.mode === 'CHARGING' || this.mode === 'FAULT';
  }

  // --------------------------------------------------------- obstacle memory
  protected learnObstacles(sense: Sense, reportedBlocked: Cell[], reportedCleared: Cell[]): void {
    const seen = new Set(sense.lidarBlocked);
    let changed = false;
    for (const c of sense.lidarCells) {
      if (seen.has(c)) {
        if (!this.blocked.has(c)) {
          this.blocked.add(c);
          this.newlyBlocked.push(c);
          changed = true;
          this.ev('info', `${this.name} lidar: aisle blocked at ${this.map.label(c)}`, c, `blk:${c}`);
        }
      } else if (this.blocked.has(c)) {
        this.blocked.delete(c);
        this.newlyCleared.push(c);
        this.clearedUntil.set(c, this.t + 20);
        changed = true;
      }
    }
    // Gossip from peers — only for cells outside my own lidar view.
    const inView = new Set(sense.lidarCells);
    for (const c of reportedBlocked) {
      if (!inView.has(c) && !this.blocked.has(c) && this.map.walkable(c) && (this.clearedUntil.get(c) ?? -1) < this.t) {
        this.blocked.add(c);
        changed = true;
      }
    }
    for (const c of reportedCleared) {
      if (!inView.has(c)) {
        this.clearedUntil.set(c, this.t + 20);
        if (this.blocked.has(c)) {
          this.blocked.delete(c);
          changed = true;
        }
      }
    }
    if (changed) this.bKey = blockedKey(this.blocked);
  }

  // ------------------------------------------------------------ task auction
  protected onOrder(o: OrderMsg): void {
    if (this.tasks.has(o.id)) return;
    this.tasks.set(o.id, {
      id: o.id,
      pickup: o.pickup,
      drop: o.drop,
      prio: o.prio,
      at: o.at,
      status: 'open',
      owner: -1,
      epoch: 0,
      bid: INF,
      closedAt: -1,
    });
  }

  /** Cost this robot would incur to serve `r` — its bid. */
  protected bidFor(r: TaskRec): number {
    const toPick = this.dist(this.pos, r.pickup);
    if (toPick >= INF || this.dist(r.pickup, r.drop) >= INF) return INF;
    const battPenalty = this.battery < 45 ? (45 - this.battery) * 0.5 : 0;
    return toPick * this.moveTicks + battPenalty;
  }

  protected myBids(): [string, number][] {
    if (!this.isFree()) return [];
    const out: [string, number][] = [];
    for (const r of this.tasks.values()) {
      if (r.status !== 'open') continue;
      const b = this.bidFor(r);
      if (b < INF) out.push([r.id, Math.round(b * 10) / 10]);
      if (out.length >= 12) break;
    }
    return out;
  }

  /** Apply peer task state from a heartbeat (claims, completions, releases). */
  protected onPeerTaskState(hb: Heartbeat): void {
    for (const id of hb.done) {
      const r = this.tasks.get(id);
      if (r) r.status = 'done';
      if (this.task && this.task.id === id && this.mode !== 'TO_DROP' && this.mode !== 'DROPPING') this.dropTask('peer completed it');
    }
    for (const id of hb.rel) {
      const r = this.tasks.get(id);
      if (r && r.status !== 'done' && r.owner === hb.from) {
        r.status = 'open';
        r.owner = -1;
        r.epoch = Math.max(r.epoch, hb.epoch) + 1;
        r.at = hb.t;
      }
    }
    if (hb.task) {
      const r = this.tasks.get(hb.task);
      if (r && r.status !== 'done') {
        // Claim conflict resolution: newer epoch wins, then lower bid, then lower id.
        const beats = (e1: number, b1: number, i1: number, e2: number, b2: number, i2: number) =>
          e1 > e2 || (e1 === e2 && (b1 < b2 || (b1 === b2 && i1 < i2)));
        if (this.task && this.task.id === hb.task && hb.from !== this.id) {
          const carrying = this.mode === 'TO_DROP' || this.mode === 'DROPPING';
          if (!carrying && beats(hb.epoch, hb.bid, hb.from, this.task.epoch, this.task.bid, this.id)) {
            this.dropTask(`${hb.task} claim won by R${hb.from + 1}`);
          }
        }
        if (r.owner === -1 || r.owner === hb.from || beats(hb.epoch, hb.bid, hb.from, r.epoch, r.bid, r.owner)) {
          r.status = 'assigned';
          r.owner = hb.from;
          r.epoch = Math.max(r.epoch, hb.epoch);
          r.bid = hb.bid;
        }
      }
    }
  }

  protected claim(r: TaskRec, bid: number): void {
    r.status = 'assigned';
    r.owner = this.id;
    r.bid = bid;
    this.task = { ...r };
    this.mode = 'TO_PICKUP';
    this.goal = r.pickup;
    this.waitAge = 0;
    this.ev('task', `${this.name} wins ${r.id} (${r.prio}) with bid ${bid.toFixed(1)}`, r.pickup, `win:${r.id}:${r.epoch}`);
  }

  protected dropTask(why: string): void {
    if (!this.task) return;
    const id = this.task.id;
    const r = this.tasks.get(id);
    if (r && r.owner === this.id && r.status !== 'done') {
      r.status = 'open';
      r.owner = -1;
      r.epoch = r.epoch + 1;
      r.at = this.t;
    }
    this.recentRelease.push({ id, until: this.t + 8 });
    this.ev('task', `${this.name} releases ${id}: ${why}`, this.task.pickup, `rel:${id}:${this.t}`);
    this.task = null;
    if (this.mode === 'TO_PICKUP' || this.mode === 'PICKING') this.mode = 'IDLE';
  }

  /**
   * Close auctions whose bid window has elapsed. Every robot runs the same
   * deterministic rule on the bids it has heard, so all robots independently
   * elect the same winner — no auctioneer exists.
   */
  protected runAuctions(candidates: Map<number, Map<string, number>>): void {
    const open = Array.from(this.tasks.values())
      .filter((r) => r.status === 'open' && this.t - r.at >= AUCTION_WINDOW)
      .sort((a, b) => PRIORITY_WEIGHT[b.prio] - PRIORITY_WEIGHT[a.prio] || a.at - b.at || (a.id < b.id ? -1 : 1));
    if (open.length === 0) return;
    const taken = new Set<number>();
    const mine = this.isFree() ? new Map(this.myBids()) : null;
    for (const r of open) {
      let best = -1;
      let bestBid = INF;
      if (mine && !taken.has(this.id)) {
        const b = mine.get(r.id);
        if (b !== undefined && b < bestBid) {
          best = this.id;
          bestBid = b;
        }
      }
      for (const [pid, bids] of candidates) {
        if (taken.has(pid)) continue;
        const b = bids.get(r.id);
        if (b === undefined) continue;
        if (b < bestBid || (b === bestBid && pid < best)) {
          best = pid;
          bestBid = b;
        }
      }
      if (best < 0) continue;
      taken.add(best);
      r.closedAt = this.t;
      if (best === this.id) this.claim(r, bestBid);
      else {
        r.status = 'assigned';
        r.owner = best;
        r.bid = bestBid;
      }
    }
  }

  // ------------------------------------------------------- mission machine
  protected advanceMission(sense: Sense): Decision['request'] {
    let request: Decision['request'] = null;
    if (sense.driveFault || sense.quarantined) {
      if (this.mode !== 'FAULT') {
        this.ev('fault', `${this.name} ${sense.quarantined ? 'quarantined by safety supervisor' : 'drive fault — self-declared FAULT'}`, this.pos, `fault:${this.id}:${this.t}`);
        if (this.task && !(this.mode === 'TO_DROP' || this.mode === 'DROPPING')) this.dropTask('robot fault');
      }
      this.mode = 'FAULT';
      this.goal = this.pos;
      return null;
    }
    if (this.mode === 'FAULT') {
      this.mode = this.task ? 'TO_DROP' : 'IDLE';
      this.ev('fault', `${this.name} recovered — rejoining fleet`, this.pos, `rec:${this.id}:${this.t}`);
    }

    if (this.awaitingPick && sense.pickResult) {
      this.awaitingPick = false;
      if (sense.pickResult === 'ok' && this.task) {
        this.mode = 'TO_DROP';
        this.goal = this.task.drop;
        this.waitAge = 0;
      } else if (this.task) {
        const r = this.tasks.get(this.task.id);
        if (r) r.status = 'done';
        this.ev('task', `${this.name}: ${this.task.id} already picked by a peer — abandoning`, this.pos, `empty:${this.task.id}`);
        this.task = null;
        this.mode = 'IDLE';
      }
    }

    switch (this.mode) {
      case 'TO_PICKUP':
        if (!this.task) {
          this.mode = 'IDLE';
          break;
        }
        this.goal = this.task.pickup;
        if (this.dist(this.pos, this.goal) >= INF) this.dropTask('pickup unreachable (aisle blocked)');
        else if (this.pos === this.task.pickup) {
          this.mode = 'PICKING';
          this.serviceLeft = SERVICE_TICKS;
        }
        break;
      case 'PICKING':
        this.goal = this.pos;
        if (--this.serviceLeft <= 0 && this.task && !this.awaitingPick) {
          this.awaitingPick = true;
          request = { type: 'pick', task: this.task.id };
        }
        break;
      case 'TO_DROP':
        if (!this.task) {
          this.mode = 'IDLE';
          break;
        }
        this.goal = this.task.drop;
        if (this.pos === this.task.drop) {
          this.mode = 'DROPPING';
          this.serviceLeft = SERVICE_TICKS;
        }
        break;
      case 'DROPPING':
        this.goal = this.pos;
        if (--this.serviceLeft <= 0 && this.task) {
          request = { type: 'drop', task: this.task.id };
          const r = this.tasks.get(this.task.id);
          if (r) r.status = 'done';
          this.recentDone.push({ id: this.task.id, until: this.t + 10 });
          this.ev('task', `${this.name} delivered ${this.task.id}`, this.pos, `done:${this.task.id}`);
          this.task = null;
          this.mode = 'IDLE';
          this.waitAge = 0;
        }
        break;
      case 'TO_CHARGER':
        if (this.pos === this.chargerClaim) this.mode = 'CHARGING';
        break;
      case 'CHARGING':
        this.goal = this.pos;
        if (sense.battery >= 95) {
          this.mode = 'IDLE';
          this.chargerClaim = -1;
        }
        break;
    }

    if (this.mode === 'IDLE' || this.mode === 'HOMING') {
      if (this.task) {
        this.mode = 'TO_PICKUP';
        this.goal = this.task.pickup;
      } else if (this.battery < LOW_BATTERY && this.map.chargers.length > 0) {
        this.chargerClaim = this.pickCharger();
        if (this.chargerClaim >= 0) {
          this.mode = 'TO_CHARGER';
          this.goal = this.chargerClaim;
          this.ev('info', `${this.name} battery ${Math.round(this.battery)}% — heading to charger ${this.map.label(this.chargerClaim)}`, this.chargerClaim, `chg:${this.id}:${this.chargerClaim}`);
        }
      } else if (this.pos !== this.home) {
        this.mode = 'HOMING';
        this.goal = this.home;
      } else {
        this.mode = 'IDLE';
        this.goal = this.pos;
      }
    }
    if (this.mode === 'TO_CHARGER') this.goal = this.chargerClaim;
    return request;
  }

  /** Chargers are shared resources: skip ones a peer has claimed. */
  protected abstract claimedChargers(): Set<Cell>;

  private pickCharger(): Cell {
    const taken = this.claimedChargers();
    let best = -1;
    let bestD = INF;
    for (const c of this.map.chargers) {
      if (taken.has(c)) continue;
      const d = this.dist(this.pos, c);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    return best;
  }

  protected tidyGossip(): void {
    this.recentDone = this.recentDone.filter((d) => d.until >= this.t);
    this.recentRelease = this.recentRelease.filter((d) => d.until >= this.t);
  }

  protected baseHeartbeat(plan: Cell[], bids: [string, number][], iso: number[], health: Heartbeat['health']): Heartbeat {
    const hb: Heartbeat = {
      k: 'HB',
      from: this.id,
      seq: ++this.seq,
      t: this.t,
      pos: this.pos,
      goal: this.goal,
      mode: this.mode,
      prio: this.task ? this.task.prio : null,
      task: this.task ? this.task.id : null,
      epoch: this.task ? this.task.epoch : 0,
      bid: this.task ? this.task.bid : 0,
      wait: this.waitAge,
      mv: this.moveTicks,
      plan,
      bids,
      done: this.recentDone.map((d) => d.id),
      rel: this.recentRelease.map((d) => d.id),
      blk: Array.from(this.blocked).slice(0, 24),
      clr: this.newlyCleared.slice(0, 12),
      chg: this.chargerClaim,
      iso,
      health,
      batt: Math.round(this.battery),
      svc: this.serviceRemaining(),
      prec: [],
    };
    this.newlyBlocked = [];
    if (this.t % 6 === 0) this.newlyCleared = [];
    return hb;
  }
}

export function isOrder(p: { k: string }): p is OrderMsg {
  return p.k === 'ORDER';
}
export { WMS_ID };
