import { AgentBase, Decision, Sense, isOrder, LOW_BATTERY } from './agentBase';
import type { WarehouseMap } from './grid';
import { Envelope, Heartbeat, Payload, encode } from './messages';
import { INF, spatialPath } from './planning';
import type { Action, AlgorithmParams, Cell } from './types';

/**
 * Baseline: independent shortest path + reactive stop-and-wait.
 *  - plans alone (A*), no prediction beyond the next cell, no reservation table;
 *  - yields only when the next cell is occupied or claimed by a lower-id robot;
 *  - after waiting too long, re-plans treating the blocker as an obstacle;
 *  - no signatures, no trust; a silent peer is simply forgotten after a timeout.
 * Same task auction and mission logic as ANVAYA, so only coordination differs.
 */
export class BaselineAgent extends AgentBase {
  private peerHb = new Map<number, { hb: Heartbeat; at: number }>();
  private path: Cell[] = [];
  private blockedFor = 0;
  private detourAvoid = new Set<Cell>();
  private detourUntil = 0;
  stats = { reroutes: 0, yields: 0, waits: 0, safetyHolds: 0 };
  plan: Cell[] = [];

  constructor(id: number, map: WarehouseMap, home: Cell, algo: AlgorithmParams) {
    super(id, map, home, algo);
  }

  protected claimedChargers(): Set<Cell> {
    const s = new Set<Cell>();
    for (const { hb } of this.peerHb.values()) if (hb.chg >= 0) s.add(hb.chg);
    return s;
  }

  think(t: number, inbox: Envelope[], sense: Sense): Decision {
    this.t = t;
    this.events = [];
    this.pos = sense.pos;
    this.battery = sense.battery;
    const blk: Cell[] = [];
    const clr: Cell[] = [];
    for (const env of inbox) {
      let p: Payload;
      try {
        p = JSON.parse(env.text) as Payload;
      } catch {
        continue;
      }
      if (isOrder(p)) {
        this.onOrder(p);
        continue;
      }
      const hb = p as Heartbeat;
      if (hb.from === this.id) continue;
      this.peerHb.set(hb.from, { hb, at: t });
      blk.push(...hb.blk);
      clr.push(...hb.clr);
      this.onPeerTaskState(hb);
    }
    // Naive liveness: forget peers not heard from recently ("offline → removed").
    for (const [id, v] of this.peerHb) if (t - v.at > this.algo.staleAfter * 3) this.peerHb.delete(id);
    this.learnObstacles(sense, blk, clr);

    // Orphaned tasks (owner forgotten) are re-auctioned.
    for (const r of this.tasks.values()) {
      if (r.status === 'assigned' && r.owner !== this.id && r.owner >= 0 && !this.peerHb.has(r.owner) && t - r.closedAt > 8) {
        r.status = 'open';
        r.owner = -1;
        r.epoch++;
        r.at = t;
      }
    }
    const bidders = new Map<number, Map<string, number>>();
    for (const [id, { hb }] of this.peerHb) {
      if (!hb.task && (hb.mode === 'IDLE' || hb.mode === 'HOMING') && hb.batt >= LOW_BATTERY + 3 && hb.health === 'OK') bidders.set(id, new Map(hb.bids));
    }
    this.runAuctions(bidders);
    const request = this.advanceMission(sense);
    this.tidyGossip();

    let next = this.pos;
    let action: Action = 'GO';
    let reason = '';
    let yieldTo = -1;

    if (this.immovable()) {
      action = this.mode === 'FAULT' ? 'STOPPED' : 'SERVICE';
      reason = this.mode === 'FAULT' ? 'Drive fault' : 'Servicing';
      this.path = [this.pos];
    } else if (this.goal !== this.pos) {
      // Replan from scratch when the path is invalid or we're off it.
      const onPath = this.path.length > 1 && this.path[0] === this.pos;
      const avoid = t < this.detourUntil ? this.detourAvoid : new Set<Cell>();
      if (!onPath || this.path.some((c) => this.blocked.has(c)) || this.path[this.path.length - 1] !== this.goal) {
        this.path = this.shortest(this.pos, this.goal, avoid) ?? [this.pos];
      }
      const want = this.path[1] ?? this.pos;
      // Reactive checks: occupied next cell, or a lower-id peer claims it next.
      let blocker = -1;
      for (const r of sense.lidarRobots) if (r.cell === want) blocker = r.id;
      if (blocker < 0) {
        // Reactive intersection rule: a lower-id robot next to my target cell goes first.
        for (const r of sense.lidarRobots) if (r.id < this.id && this.map.adjacent(r.cell, want)) {
          const hb = this.peerHb.get(r.id)?.hb;
          if (!hb || hb.goal !== hb.pos) blocker = r.id;
        }
      }
      if (blocker < 0) {
        for (const [id, { hb }] of this.peerHb) {
          const peerNext = hb.plan[1] ?? hb.pos;
          if (peerNext === want && id < this.id) blocker = id;
          if (hb.pos === want) blocker = id;
        }
      }
      if (blocker >= 0) {
        this.blockedFor++;
        yieldTo = blocker;
        action = 'YIELD';
        this.stats.yields++;
        reason = `Stop-and-wait: R${blocker + 1} in / entering my next cell`;
        if (this.blockedFor >= 6) {
          // Reactive detour around the blocker.
          const avoidNow = new Set<Cell>(sense.lidarRobots.map((r) => r.cell));
          const alt = this.shortest(this.pos, this.goal, avoidNow);
          if (alt && alt[1] !== want) {
            this.path = alt;
            this.detourAvoid = avoidNow;
            this.detourUntil = t + 12;
            this.stats.reroutes++;
            action = 'REROUTE';
            reason = 'Blocked too long — reactive detour';
            this.blockedFor = 0;
            const n2 = this.path[1];
            if (!sense.lidarRobots.some((r) => r.cell === n2)) next = n2;
          }
        }
      } else {
        next = want;
        this.path.shift();
        this.blockedFor = 0;
        reason = `Go → ${this.map.label(this.goal)}`;
      }
    } else {
      action = 'WAIT';
      reason = 'At goal';
    }

    if (this.goal !== this.pos && next === this.pos && !this.immovable()) {
      this.waitAge++;
      this.totalWait++;
    }
    this.plan = [this.pos, next];
    const hb = this.baseHeartbeat([this.pos, next], this.myBids(), [], this.mode === 'FAULT' ? 'FAULT' : 'OK');
    const envelopes: Envelope[] = [{ from: this.id, text: encode(hb), sig: null, sentAt: t, origin: this.pos, tag: 'hb' }];
    return { next, action, reason, yieldTo, plan: this.plan, envelopes, events: this.events, request };
  }

  private shortest(a: Cell, b: Cell, avoid: Set<Cell>): Cell[] | null {
    if (avoid.size === 0) return spatialPath(this.map, a, b, this.field(b));
    const merged = new Set<Cell>([...this.blocked, ...avoid]);
    merged.delete(a);
    // local import-free BFS on merged blocked set
    const n = this.map.n;
    const d = new Int32Array(n).fill(INF);
    const q = new Int32Array(n);
    let h = 0;
    let tl = 0;
    d[b] = 0;
    q[tl++] = b;
    while (h < tl) {
      const c = q[h++];
      for (const m of this.map.nbrs[c]) {
        if (d[m] > d[c] + 1 && !merged.has(m)) {
          d[m] = d[c] + 1;
          q[tl++] = m;
        }
      }
    }
    return spatialPath(this.map, a, b, d);
  }
}
