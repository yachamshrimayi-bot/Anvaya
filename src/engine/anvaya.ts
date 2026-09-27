import { AgentBase, AgentEvent, Decision, Sense, isOrder, LOW_BATTERY } from './agentBase';
import { Identity, Registry, signText, verifySig } from './crypto';
import type { WarehouseMap } from './grid';
import { Envelope, Heartbeat, Payload, WMS_ID, encode } from './messages';
import { INF, PROTECTED, ReservationTable, spaceTimeAStar, spatialPath, timePath } from './planning';
import type { Action, AlgorithmParams, Cell, PeerHealth, Priority } from './types';
import { IDLE_WEIGHT, PRIORITY_WEIGHT } from './types';

/** Everything one robot believes about one peer — built only from signed messages and its own lidar. */
export interface PeerBelief {
  id: number;
  hb: Heartbeat | null;
  prevHb: Heartbeat | null;
  lastSeq: number;
  lastHeard: number;
  trust: number;
  health: PeerHealth;
  credPos: Cell;
  credT: number;
  consecutiveOk: number;
  mismatches: number;
  lidarCell: Cell;
  isolatedSince: number;
  /** Plausible heartbeats by send tick (commitment look-up). */
  recent: Map<number, Heartbeat>;
}

export interface TrustEvent {
  t: number;
  observer: number;
  subject: number;
  type: string;
  delta: number;
  trust: number;
  detail: string;
}

/** One entry of the fleet view a robot reasons over (self + trusted, live peers). */
interface Entry {
  id: number;
  pos: Cell;
  goal: Cell;
  weight: number;
  wait: number;
  trust: number;
  mv: number;
  fixed: boolean; // servicing / charging / fault: cannot move this horizon
  fixedUntil: number; // tick index until which a fixed robot stays put
  hold: number; // ticks it will occupy its goal after arrival
  mode: string;
  announced: Cell[]; // latency-compensated announced plan (t=0 is now)
  self: boolean;
  eff: number; // effective priority = weight + ε · waiting age
}

export interface PrecedenceRecord {
  a: number;
  b: number;
  winner: number;
  cell: Cell;
  t: number;
  costAFirst: number;
  costBFirst: number;
  delayA: number;
  delayB: number;
  since: number;
  basis: 'fleet-cost' | 'priority' | 'fixed' | 'held';
  seen?: number;
  /** Winner's waiting age when the decision was taken (to detect a stuck winner). */
  winnerWait?: number;
}

export interface AgentDebug {
  cluster: number[];
  order: number[];
  conflicts: { a: number; b: number; cell: Cell; t: number }[];
  precedence: PrecedenceRecord[];
  protectedCells: Cell[];
  desired: Map<number, Cell[]>;
  replicated: Map<number, Cell[]>;
  staExpanded: number;
  thinkMs: number;
  deaf: boolean;
}

const TRUST = {
  VALID: 0.02,
  INFEASIBLE_PLAN: -0.3,
  IMPOSSIBLE_MOTION: -0.35,
  LIDAR_CONTRADICTION: -0.4,
  IMPLAUSIBLE_BID: -0.25,
  EXECUTION_MISMATCH: -0.05,
  STALE_TICK: -0.03,
  STALE_FLOOR: 0.45,
  REJOIN_AFTER: 12,
};

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

export class AnvayaAgent extends AgentBase {
  readonly identity: Identity;
  readonly registry: Registry;
  readonly peers = new Map<number, PeerBelief>();
  readonly trustLog: TrustEvent[] = [];
  /** Precedence decisions this robot has committed to (hysteresis memory). */
  readonly precedenceMemo = new Map<string, PrecedenceRecord>();
  plan: Cell[] = [];
  prevRoute = new Set<Cell>();
  routeSince = 0;
  lastHeardAny = 0;
  lastSentPlan: Cell[] = [];
  lastSentT = 0;
  moveHistory: boolean[] = [];
  lastCommand: Cell = -1;
  compromised = false;
  crypto: boolean;
  /** What I computed each predecessor would do at tick τ — checked when its τ heartbeat arrives. */
  private replicaLog = new Map<number, Map<number, Cell>>();
  private routeGoal: Cell = -1;
  private lastAction: Action = 'GO';
  private lastYieldTo = -1;
  /** My own signed intents by send tick — the source of my binding commitments. */
  readonly sentPlans = new Map<number, Cell[]>();
  debug: AgentDebug = {
    cluster: [],
    order: [],
    conflicts: [],
    precedence: [],
    protectedCells: [],
    desired: new Map(),
    replicated: new Map(),
    staExpanded: 0,
    thinkMs: 0,
    deaf: false,
  };
  stats = { reroutes: 0, yields: 0, waits: 0, safetyHolds: 0, commitHolds: 0, agreement: 0, agreementN: 0, clusterSum: 0, clusterN: 0 };

  constructor(id: number, map: WarehouseMap, home: Cell, algo: AlgorithmParams, identity: Identity, registry: Registry, fleet: number[], crypto: boolean) {
    super(id, map, home, algo);
    this.identity = identity;
    this.registry = registry;
    this.crypto = crypto;
    for (const pid of fleet) {
      if (pid === id) continue;
      this.peers.set(pid, {
        id: pid,
        hb: null,
        prevHb: null,
        lastSeq: -1,
        lastHeard: -1000,
        trust: 1,
        health: 'STALE',
        credPos: -1,
        credT: -1,
        consecutiveOk: 0,
        mismatches: 0,
        lidarCell: -1,
        isolatedSince: -1,
        recent: new Map(),
      });
    }
    this.plan = [home];
  }

  // =====================================================================
  // Main loop — one control cycle.
  // =====================================================================
  think(t: number, inbox: Envelope[], sense: Sense): Decision {
    const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
    this.t = t;
    this.events = [];
    this.pos = sense.pos;
    this.battery = sense.battery;

    // 1. OBSERVE — authenticate, sanity-check and absorb peer messages + own lidar.
    const gossipBlk: Cell[] = [];
    const gossipClr: Cell[] = [];
    this.observeLidar(sense);
    for (const env of inbox) this.receive(env, sense, gossipBlk, gossipClr);
    this.learnObstacles(sense, gossipBlk, gossipClr);
    this.updateLiveness();

    // 6. VERIFY (self) — compare what I commanded with what physically happened.
    this.verifySelf(sense);

    // Mission + decentralised auction.
    this.reassignOrphans();
    this.runAuctions(this.bidderTable());
    const request = this.advanceMission(sense);
    this.tidyGossip();

    const deaf = t - this.lastHeardAny > this.algo.staleAfter * 2 && this.peers.size > 0;
    this.debug.deaf = deaf;

    let next = this.pos;
    let action: Action = 'GO';
    let reason = '';
    let yieldTo = -1;

    if (this.immovable()) {
      this.plan = new Array(this.algo.horizon + 1).fill(this.pos);
      action = this.mode === 'FAULT' ? 'STOPPED' : 'SERVICE';
      reason =
        this.mode === 'FAULT'
          ? sense.quarantined
            ? 'Quarantined: peers voted me untrusted — safety supervisor holds the drive'
            : 'Drive fault — holding; peers route around me'
          : this.mode === 'CHARGING'
            ? `Charging (${Math.round(this.battery)}%)`
            : `${this.mode === 'PICKING' ? 'Picking' : 'Dropping'} ${this.task?.id ?? ''}`;
      this.debug.cluster = [this.id];
      this.debug.order = [this.id];
      this.debug.conflicts = [];
      this.debug.precedence = [];
    } else if (!sense.radioUp) {
      // Radio hardware reports link-down: immediate safe stop. Peers will see me go
      // silent and keep my last intent protected; I resume once the link is back.
      next = this.pos;
      action = 'HOLD';
      reason = 'Radio link down — safe stop in place (peers protect my last intent: unknown ≠ free)';
      this.plan = new Array(this.algo.horizon + 1).fill(this.pos);
    } else if (deaf) {
      // Safe degradation: without fresh peer state I only keep the promises peers
      // last received from me (they keep those cells protected), then stop.
      const prefix = this.promisePrefix();
      const g = this.gate(prefix[1], sense);
      next = g.ok ? prefix[1] : this.pos;
      action = next === this.pos ? 'HOLD' : 'GO';
      reason = next === this.pos ? 'Comms lost: safe stop — peers keep my last intent protected (unknown ≠ free)' : 'Comms lost: finishing my last announced intent only';
      this.plan = [...prefix, ...new Array(Math.max(0, this.algo.horizon + 1 - prefix.length)).fill(prefix[prefix.length - 1])];
      if (next === this.pos) this.plan = new Array(this.algo.horizon + 1).fill(this.pos);
    } else {
      const r = this.coordinate(sense);
      next = r.next;
      action = r.action;
      reason = r.reason;
      yieldTo = r.yieldTo;
    }

    // Waiting age (fairness input) grows while I have somewhere to be but stand still.
    const hasGoal = this.goal !== this.pos && !this.immovable();
    if (hasGoal && next === this.pos) {
      this.waitAge += 1;
      this.totalWait += 1;
    }

    this.lastCommand = next;

    // 5. EXECUTE — publish signed intent.
    const envelopes: Envelope[] = [];
    const hb = this.buildHeartbeat();
    const text = encode(hb);
    envelopes.push({
      from: this.id,
      text,
      sig: this.crypto ? signText(this.identity, text) : null,
      sentAt: t,
      origin: this.pos,
      tag: 'hb',
    });
    this.sentPlans.set(t, hb.plan.slice());
    for (const k of this.sentPlans.keys()) if (k < t - 12) this.sentPlans.delete(k);
    if (!deaf) {
      this.lastSentPlan = this.plan.slice();
      this.lastSentT = t;
    }

    this.debug.thinkMs = typeof performance !== 'undefined' ? performance.now() - t0 : 0;
    return { next, action, reason, yieldTo, plan: this.plan.slice(), envelopes, events: this.events, request };
  }

  // =====================================================================
  // OBSERVE
  // =====================================================================
  private observeLidar(sense: Sense): void {
    for (const p of this.peers.values()) p.lidarCell = -1;
    for (const r of sense.lidarRobots) {
      const p = this.peers.get(r.id);
      if (p) p.lidarCell = r.cell;
    }
  }

  private penalize(p: PeerBelief, type: keyof typeof TRUST, detail: string): void {
    if (!this.algo.useTrust) return;
    const delta = TRUST[type];
    const before = p.trust;
    p.trust = clamp01(Math.round((p.trust + delta) * 1000) / 1000);
    p.consecutiveOk = 0;
    this.trustLog.push({ t: this.t, observer: this.id, subject: p.id, type, delta, trust: p.trust, detail });
    if (this.trustLog.length > 200) this.trustLog.shift();
    if (delta <= -0.2) {
      this.ev('security', `${this.name} flags R${p.id + 1}: ${type.replace(/_/g, ' ').toLowerCase()} (${detail}) → trust ${before.toFixed(2)}→${p.trust.toFixed(2)}`, p.credPos >= 0 ? p.credPos : undefined, `sec:${p.id}:${type}:${this.t}`);
    }
    if (p.trust < this.algo.isolationThreshold && p.health !== 'ISOLATED') {
      p.health = 'ISOLATED';
      p.isolatedSince = this.t;
      this.ev('trust', `${this.name} isolates R${p.id + 1} (trust ${p.trust.toFixed(2)} < ${this.algo.isolationThreshold}) — barred from auctions, treated as a hazard`, p.credPos >= 0 ? p.credPos : undefined, `iso:${p.id}`);
    }
  }

  private receive(env: Envelope, sense: Sense, blk: Cell[], clr: Cell[]): void {
    let payload: Payload;
    try {
      payload = JSON.parse(env.text) as Payload;
    } catch {
      return;
    }
    // Authenticate: the claimed sender's enrolled key must verify the signature.
    if (this.crypto) {
      const pk = this.registry.get(env.from);
      if (!pk || !env.sig || payload.from !== env.from || !verifySig(pk, env.text, env.sig)) {
        this.ev('security', `${this.name} rejected a forged message claiming to be ${env.from === WMS_ID ? 'WMS' : `R${env.from + 1}`} (Ed25519 signature invalid)`, undefined, `forged:${env.from}:${this.t}`);
        return;
      }
    }
    this.lastHeardAny = this.t;

    if (isOrder(payload)) {
      this.onOrder(payload);
      return;
    }
    const hb = payload as Heartbeat;
    const p = this.peers.get(hb.from);
    if (!p || hb.from === this.id) return;

    // Replay protection: sequence numbers must strictly increase.
    if (hb.seq <= p.lastSeq) {
      this.ev('security', `${this.name} dropped a replayed message from R${hb.from + 1} (seq ${hb.seq} ≤ ${p.lastSeq})`, undefined, `replay:${hb.from}:${this.t}`);
      return;
    }
    p.lastSeq = hb.seq;
    p.lastHeard = this.t;

    // Plausibility checks (behavioural trust).
    let ok = true;
    const plan = hb.plan;
    let feasible = plan.length > 0 && plan[0] === hb.pos && this.map.walkable(hb.pos);
    for (let i = 1; feasible && i < plan.length; i++) {
      if (!this.map.walkable(plan[i]) || (plan[i] !== plan[i - 1] && !this.map.adjacent(plan[i], plan[i - 1]))) feasible = false;
    }
    if (!feasible) {
      this.penalize(p, 'INFEASIBLE_PLAN', 'intent jumps across the map');
      ok = false;
    }
    if (p.credT >= 0 && p.credPos >= 0) {
      const dt = hb.t - p.credT;
      if (this.map.manhattan(hb.pos, p.credPos) > dt + 1) {
        this.penalize(p, 'IMPOSSIBLE_MOTION', `${this.map.label(p.credPos)}→${this.map.label(hb.pos)} in ${dt} ticks`);
        ok = false;
      }
    }
    if (p.lidarCell >= 0 && this.t - hb.t <= 1 && this.map.manhattan(p.lidarCell, hb.pos) > 1 + (this.t - hb.t)) {
      this.penalize(p, 'LIDAR_CONTRADICTION', `claims ${this.map.label(hb.pos)}, lidar sees ${this.map.label(p.lidarCell)}`);
      ok = false;
    }
    for (const [tid, b] of hb.bids) {
      const r = this.tasks.get(tid);
      if (r && b + 0.5 < this.map.manhattan(hb.pos, r.pickup)) {
        this.penalize(p, 'IMPLAUSIBLE_BID', `bid ${b} for ${tid}`);
        ok = false;
        break;
      }
    }
    // Plan-vs-reality: where did its previous intent say it would be now?
    if (ok && p.hb) {
      const k = hb.t - p.hb.t;
      const expect = k < p.hb.plan.length ? p.hb.plan[k] : p.hb.plan[p.hb.plan.length - 1];
      if (expect !== hb.pos && this.map.manhattan(expect, hb.pos) >= 1) {
        p.mismatches++;
        if (p.mismatches >= 2) this.penalize(p, 'EXECUTION_MISMATCH', 'position diverges from its own intent');
      } else p.mismatches = Math.max(0, p.mismatches - 1);
    }

    if (ok) {
      p.recent.set(hb.t, hb);
      for (const k of p.recent.keys()) if (k < this.t - 12) p.recent.delete(k);
      p.credPos = hb.pos;
      p.credT = hb.t;
      p.consecutiveOk++;
      if (this.algo.useTrust && p.health !== 'ISOLATED') p.trust = clamp01(Math.round((p.trust + TRUST.VALID) * 1000) / 1000);
      if (p.health === 'ISOLATED' && p.consecutiveOk >= TRUST.REJOIN_AFTER) {
        p.health = 'RECOVERING';
        p.trust = this.algo.isolationThreshold + 0.05;
        this.ev('trust', `${this.name} re-admits R${p.id + 1} on probation after ${TRUST.REJOIN_AFTER} consistent messages`, hb.pos, `rejoin:${p.id}:${this.t}`);
      }
    }
    // Decision agreement: did its own decision at τ match my replicated one?
    const rep = this.replicaLog.get(hb.t)?.get(hb.from);
    if (rep !== undefined && hb.plan.length > 1) {
      this.stats.agreementN++;
      if (hb.plan[1] === rep) this.stats.agreement++;
    }
    if (p.health === 'ISOLATED') return; // an isolated peer's claims are not believed
    // Decision reconciliation: for our pair, the lower-id robot's announced decision is authoritative.
    if (hb.from < this.id && hb.prec) {
      for (const [w, l] of hb.prec) {
        if ((w === this.id && l === hb.from) || (w === hb.from && l === this.id)) {
          const key = `${hb.from}-${this.id}`;
          const mine = this.precedenceMemo.get(key);
          if (!mine || mine.winner !== w) {
            this.precedenceMemo.set(key, {
              a: hb.from, b: this.id, winner: w, cell: mine?.cell ?? hb.pos, t: 0, costAFirst: mine?.costAFirst ?? 0, costBFirst: mine?.costBFirst ?? 0,
              delayA: mine?.delayA ?? 0, delayB: mine?.delayB ?? 0, since: this.t, basis: 'held',
              winnerWait: w === this.id ? this.waitAge : hb.wait,
            });
          }
        }
      }
    }
    p.prevHb = p.hb;
    p.hb = hb;
    for (const c of hb.blk) blk.push(c);
    for (const c of hb.clr) clr.push(c);
    this.onPeerTaskState(hb);
  }

  private updateLiveness(): void {
    const s = this.algo.staleAfter;
    for (const p of this.peers.values()) {
      if (p.health === 'ISOLATED') continue;
      const age = this.t - p.lastHeard;
      const prev = p.health;
      if (age <= s) p.health = p.health === 'RECOVERING' && p.trust < 0.7 ? 'RECOVERING' : 'HEALTHY';
      else if (age <= s * 3) p.health = 'STALE';
      else p.health = 'UNRESPONSIVE';
      if (age > s && this.algo.useTrust && p.trust > TRUST.STALE_FLOOR && p.hb) {
        p.trust = Math.max(TRUST.STALE_FLOOR, Math.round((p.trust + TRUST.STALE_TICK) * 1000) / 1000);
      }
      if (prev === 'HEALTHY' && p.health === 'STALE' && p.hb) {
        this.ev('safety', `${this.name}: R${p.id + 1} silent for ${age} ticks — its last intent stays protected (unknown ≠ free)`, p.credPos, `stale:${p.id}:${p.lastHeard}`);
      }
    }
  }

  private verifySelf(sense: Sense): void {
    const commanded = this.lastCommand;
    if (commanded >= 0 && commanded !== sense.pos && !sense.estopped && !sense.driveFault && !sense.quarantined) {
      // I asked to move; did I?
      this.moveHistory.push(sense.moved);
      if (this.moveHistory.length > 8) this.moveHistory.shift();
    } else if (commanded >= 0 && sense.moved) {
      this.moveHistory.push(true);
      if (this.moveHistory.length > 8) this.moveHistory.shift();
    }
    const h = this.moveHistory;
    if (h.length >= 6) {
      const ok = h.filter(Boolean).length / h.length;
      if (this.moveTicks === 1 && ok <= 0.65) {
        this.moveTicks = 2;
        this.ev('fault', `${this.name} self-diagnosis: moving at ~${Math.round(ok * 100)}% of commanded speed — re-planning at half speed and announcing it`, this.pos, `slow:${this.id}:${this.t}`);
      } else if (this.moveTicks === 2 && h.length === 8 && ok >= 0.99) {
        // at mv=2 a healthy drive also succeeds on every attempted move
      }
    }
  }

  /** A slow-mode robot periodically probes full speed (health restored?). */
  private probeSpeed(): void {
    if (this.moveTicks === 2 && this.t % 40 === 0) {
      this.moveTicks = 1;
      this.moveHistory = [];
    }
  }

  // =====================================================================
  // Task reassignment (fault containment for missions)
  // =====================================================================
  private reassignOrphans(): void {
    for (const r of this.tasks.values()) {
      if (r.status !== 'assigned' || r.owner === this.id || r.owner < 0) continue;
      const p = this.peers.get(r.owner);
      if (!p) continue;
      const hb = p.hb;
      const carrying = hb && hb.task === r.id && (hb.mode === 'TO_DROP' || hb.mode === 'DROPPING');
      if (carrying) continue;
      const claimMissing = hb && r.closedAt >= 0 && this.t - r.closedAt > 5 && hb.t > r.closedAt + 1 && hb.task !== r.id;
      const dead = p.health === 'UNRESPONSIVE' || p.health === 'ISOLATED' || (hb && hb.health === 'FAULT');
      if (dead || claimMissing) {
        r.status = 'open';
        r.owner = -1;
        r.epoch += 1;
        r.at = this.t;
        r.closedAt = -1;
        if (dead) this.ev('task', `${r.id} re-auctioned: owner R${p.id + 1} is ${p.health === 'ISOLATED' ? 'isolated' : hb && hb.health === 'FAULT' ? 'faulted' : 'unresponsive'}`, r.pickup, `reassign:${r.id}:${r.epoch}`);
      }
    }
  }

  private bidderTable(): Map<number, Map<string, number>> {
    const out = new Map<number, Map<string, number>>();
    for (const p of this.peers.values()) {
      if (!p.hb || p.health === 'ISOLATED' || p.health === 'UNRESPONSIVE' || p.health === 'STALE') continue;
      const hb = p.hb;
      if (hb.task || hb.health !== 'OK' || !(hb.mode === 'IDLE' || hb.mode === 'HOMING') || hb.batt < LOW_BATTERY + 3) continue;
      out.set(p.id, new Map(hb.bids));
    }
    return out;
  }

  protected claimedChargers(): Set<Cell> {
    const s = new Set<Cell>();
    for (const p of this.peers.values()) if (p.hb && p.hb.chg >= 0 && p.health !== 'UNRESPONSIVE') s.add(p.hb.chg);
    return s;
  }

  // =====================================================================
  // PREDICT → RESERVE → DECIDE: the replicated fleet decision
  // =====================================================================
  private margin(trust: number): number {
    if (!this.algo.useTrust) return 0;
    return trust >= 0.9 ? 0 : trust >= 0.7 ? 1 : 2;
  }

  private effPriority(weight: number, wait: number): number {
    return weight + (this.algo.useFairness ? this.algo.wFairness * wait : 0);
  }

  private buildView(sense: Sense): { entries: Entry[]; protectedCells: Set<Cell>; hazards: Map<number, Cell[]> } {
    const H = this.algo.horizon;
    const entries: Entry[] = [];
    const protectedCells = new Set<Cell>();
    const hazards = new Map<number, Cell[]>();
    const selfWeight = this.task ? PRIORITY_WEIGHT[this.task.prio] : IDLE_WEIGHT;
    entries.push({
      id: this.id,
      pos: this.pos,
      goal: this.goal,
      weight: selfWeight,
      wait: this.waitAge,
      trust: 1,
      mv: this.moveTicks,
      fixed: false,
      fixedUntil: 0,
      hold: this.goalHoldFor(this.mode, H),
      mode: this.mode,
      announced: [],
      self: true,
      eff: this.effPriority(selfWeight, this.waitAge),
    });

    for (const p of this.peers.values()) {
      const hb = p.hb;
      if (p.health === 'ISOLATED' || !hb) {
        // Untrusted or never heard: protect where lidar sees it, else its last credible cell.
        const at = p.lidarCell >= 0 ? p.lidarCell : p.credPos;
        if (at >= 0) {
          const cells = [at, ...Array.from(this.map.nbrs[at])];
          hazards.set(p.id, cells);
          for (const c of cells) protectedCells.add(c);
        }
        continue;
      }
      const age = Math.max(0, this.t - hb.t);
      if (p.health === 'STALE' || p.health === 'UNRESPONSIVE') {
        // Unknown ≠ free: it is somewhere along its last announced intent.
        const cells = new Set<Cell>();
        for (let i = 0; i < hb.plan.length; i++) cells.add(hb.plan[i]);
        if (p.lidarCell >= 0) cells.add(p.lidarCell);
        hazards.set(p.id, Array.from(cells));
        for (const c of cells) protectedCells.add(c);
        continue;
      }
      // Latency compensation: shift its intent by the message age.
      const shifted: Cell[] = new Array(H + 1);
      for (let i = 0; i <= H; i++) {
        const j = Math.min(hb.plan.length - 1, i + age);
        shifted[i] = hb.plan[j];
      }
      const pos = p.lidarCell >= 0 ? p.lidarCell : shifted[0];
      if (shifted[0] !== pos) shifted[0] = pos;
      const fixed = hb.mode === 'PICKING' || hb.mode === 'DROPPING' || hb.mode === 'CHARGING' || hb.mode === 'FAULT' || hb.health === 'FAULT';
      const fixedUntil = !fixed ? 0 : hb.svc < 0 || hb.health === 'FAULT' ? H : Math.min(H, Math.max(1, hb.svc - age + 1));
      const w = hb.prio ? PRIORITY_WEIGHT[hb.prio] : IDLE_WEIGHT;
      entries.push({
        id: p.id,
        pos,
        goal: fixed ? pos : hb.goal,
        weight: w,
        wait: hb.wait + age,
        trust: p.trust,
        mv: Math.max(1, hb.mv | 0),
        fixed,
        fixedUntil,
        hold: this.goalHoldFor(hb.mode, H),
        mode: hb.mode,
        announced: shifted,
        self: false,
        eff: this.effPriority(w, hb.wait + age),
      });
    }
    // Robots my lidar sees but my network view lacks are hazards too.
    for (const r of sense.lidarRobots) {
      if (!entries.some((e) => e.id === r.id) && !hazards.has(r.id)) {
        hazards.set(r.id, [r.cell]);
        protectedCells.add(r.cell);
      }
    }
    return { entries, protectedCells, hazards };
  }

  private desiredPath(e: Entry): Cell[] {
    const H = this.algo.horizon;
    if (e.fixed) {
      const out = new Array(H + 1).fill(e.pos);
      for (let t = e.fixedUntil + 1; t <= H; t++) out[t] = -1; // leaves afterwards (unknown)
      return out;
    }
    if (e.pos === e.goal) return new Array(H + 1).fill(e.pos);
    const f = this.field(e.goal);
    const sp = spatialPath(this.map, e.pos, e.goal, f, H + 2);
    if (!sp) return new Array(H + 1).fill(e.pos);
    const timed = timePath(sp, H, e.mv);
    const arr = timed.indexOf(e.goal);
    if (arr >= 0) for (let t = arr + e.hold + 1; t <= H; t++) timed[t] = -1;
    return timed;
  }

  /** First space-time conflict between two timed paths (vertex, swap, or margin overlap). */
  private firstConflict(a: Cell[], b: Cell[], margin: number): { t: number; cell: Cell } | null {
    const H = Math.min(a.length, b.length) - 1;
    for (let t = 1; t <= H; t++) {
      if (a[t] < 0) continue;
      for (let d = -margin; d <= margin; d++) {
        const u = t + d;
        if (u < 0 || u > H) continue;
        if (a[t] === b[u]) return { t, cell: a[t] };
      }
      if (a[t] === b[t - 1] && b[t] === a[t - 1] && a[t] !== a[t - 1] && b[t] >= 0) return { t, cell: a[t] };
    }
    return null;
  }

  private baseTable(entries: Entry[], protectedCells: Set<Cell>): ReservationTable {
    const H = this.algo.horizon;
    const rt = new ReservationTable(this.map.n, H);
    for (const c of protectedCells) rt.reservePerm(c, PROTECTED);
    for (const c of this.blocked) rt.reservePerm(c, PROTECTED);
    for (const e of entries) {
      if (e.fixed) {
        for (let t = 0; t <= Math.min(H, e.fixedUntil + 1); t++) rt.reserve(e.pos, t, e.id);
        continue;
      }
      // Current cell is held at t=0 and t=1 (the robot may choose to stay).
      rt.reserve(e.pos, 0, e.id);
      rt.reserve(e.pos, 1, e.id);
      // Its binding promises for the next K ticks are reserved for it (it may also stay),
      // and it cannot leave its last promised cell before K+1: that is the earliest
      // moment a peer's new decision can take effect. Applied to myself too, so the
      // replicas I compute see me exactly as my peers do.
      {
        const K = this.K();
        let last = e.pos;
        for (let i = 1; i <= K && i < e.announced.length; i++) {
          rt.reserve(e.announced[i], i, e.id);
          rt.reserve(e.announced[i - 1], i, e.id);
          last = e.announced[i];
        }
        rt.reserve(last, K + 1, e.id);
      }
    }
    return rt;
  }

  private sta(e: Entry, rt: ReservationTable, extras?: { cong?: Float32Array; unc?: Float32Array; prev?: Set<Cell> }, startT = 0, locked = false) {
    const a = this.algo;
    return spaceTimeAStar({
      map: this.map,
      start: e.pos,
      goal: e.goal,
      self: e.id,
      horizon: a.horizon,
      rt,
      field: this.field(e.goal),
      blocked: this.blocked,
      moveTicks: e.mv,
      wDelay: a.wDelay,
      wEnergy: a.wEnergy,
      wCongestion: a.wCongestion,
      wUncertainty: a.wUncertainty,
      wReplan: a.wReplan,
      congestion: extras?.cong ?? null,
      uncertainty: extras?.unc ?? null,
      prevRoute: extras?.prev ?? null,
      goalHold: e.hold,
      startT,
      startLocked: locked,
    });
  }

  K(): number {
    return Math.max(1, this.algo.commitLead | 0);
  }

  /**
   * My binding promises for t+1..t+K. The intent I signed at τ promised cell
   * plan[K+1] for time τ+K+1. If I fell behind a promise (e.g. I had to hold),
   * every later promise is void and I stay put until new promises are published.
   */
  promisePrefix(): Cell[] {
    const K = this.K();
    const pre: Cell[] = [this.pos];
    let valid = true;
    for (let i = 1; i <= K; i++) {
      const prev = pre[i - 1];
      const ann = this.sentPlans.get(this.t - K - 1 + i);
      let c = prev;
      if (valid && ann && ann.length > K + 1 && ann[K] === prev) {
        const cand = ann[K + 1];
        if (cand === prev || (this.map.adjacent(cand, prev) && !this.blocked.has(cand))) c = cand;
        else valid = false;
      } else valid = false;
      pre.push(c);
    }
    return pre;
  }

  /** Where peer `id` can be at t+1 according to its binding promise; undefined = unknown. */
  private peerPromise(id: number, at: Cell): Cell | undefined {
    const p = this.peers.get(id);
    if (!p || p.health === 'ISOLATED') return undefined;
    const K = this.K();
    const hb = p.recent.get(this.t - K);
    if (!hb || hb.plan.length <= K) return undefined;
    if (hb.plan[K] !== at) return at; // off its promises -> it must stay put this tick
    return hb.plan[K + 1] ?? hb.plan[hb.plan.length - 1];
  }

  /**
   * Right-of-way gate. Any robot that could enter `next` this tick is adjacent to it
   * and therefore inside my lidar range, so both of us evaluate this rule on the same
   * facts: (1) never enter an occupied cell; (2) among robots that may enter the cell
   * — those whose binding promise is that cell, or whose promise is unknown — only
   * the lowest id proceeds. Hence two robots can never enter one cell together, and
   * never swap.
   */
  gate(next: Cell, sense: Sense): { ok: boolean; reason: string; blocker: number } {
    if (next === this.pos) return { ok: true, reason: '', blocker: -1 };
    for (const r of sense.lidarRobots) {
      if (r.cell === next) return { ok: false, reason: `Safety hold: lidar sees R${r.id + 1} in my next cell`, blocker: r.id };
    }
    for (const r of sense.lidarRobots) {
      if (!this.map.adjacent(r.cell, next) || r.id > this.id) continue;
      const pr = this.peerPromise(r.id, r.cell);
      if (pr === undefined) return { ok: false, reason: `Right-of-way: R${r.id + 1}'s intent is unknown next to ${this.map.label(next)} (unknown ≠ free)`, blocker: r.id };
      if (pr === next) return { ok: false, reason: `Right-of-way: R${r.id + 1} also committed to ${this.map.label(next)} and has precedence`, blocker: r.id };
    }
    return { ok: true, reason: '', blocker: -1 };
  }

  /** Make a timed plan physically consistent (every step stays or moves to a neighbour). */
  private sanitize(plan: Cell[]): Cell[] {
    const out = [plan[0]];
    for (let i = 1; i < plan.length; i++) {
      const c = plan[i];
      const prev = out[i - 1];
      out.push(c === prev || this.map.adjacent(c, prev) ? c : prev);
    }
    return out;
  }

  private coordinate(sense: Sense): { next: Cell; action: Action; reason: string; yieldTo: number } {
    const a = this.algo;
    const H = a.horizon;
    this.probeSpeed();
    const { entries, protectedCells, hazards } = this.buildView(sense);
    entries[0].announced = this.promisePrefix();
    // A promise into a cell that is occupied right now cannot be honoured (the gate
    // will hold that robot), so everyone — including the promiser — plans it as staying.
    {
      const occ = new Map<Cell, number>();
      for (const e of entries) occ.set(e.pos, e.id);
      for (const r of sense.lidarRobots) occ.set(r.cell, r.id);
      for (const e of entries) {
        const a1 = e.announced[1];
        if (a1 === undefined || a1 === e.pos) continue;
        const o = occ.get(a1);
        if (o !== undefined && o !== e.id) e.announced = e.announced.map((_, i) => (i === 0 ? e.pos : e.pos)).concat([]);
      }
    }
    const byId = new Map(entries.map((e) => [e.id, e]));
    const me = entries[0];

    // ---- PREDICT: future space-time occupancy of everyone I can see.
    const desired = new Map<number, Cell[]>();
    for (const e of entries) desired.set(e.id, this.desiredPath(e));
    this.debug.desired = desired;

    // ---- Conflict graph (coordinate only robots that actually interact).
    // Grown lazily outward from me: each robot popped from the frontier is tested
    // against the not-yet-popped robots, so every pair inside my cluster (and every
    // edge leaving it) is examined exactly once — O(k·N) instead of O(N²).
    const conflicts: { a: number; b: number; cell: Cell; t: number }[] = [];
    const effHorizon = a.useReservations ? H : 1;
    const idxOf = new Map(entries.map((e, i) => [e.id, i]));
    const cut = new Map<number, Cell[]>();
    const cutOf = (id: number) => {
      let c = cut.get(id);
      if (!c) cut.set(id, (c = desired.get(id)!.slice(0, effHorizon + 1)));
      return c;
    };
    const cluster: number[] = [];
    {
      const popped = new Set<number>();
      const seen = new Set<number>([this.id]);
      const q = [this.id];
      while (q.length) {
        const x = q.shift()!;
        popped.add(x);
        cluster.push(x);
        const ex = entries[idxOf.get(x)!];
        for (const ey of entries) {
          if (ey.id === x || popped.has(ey.id)) continue;
          if (this.map.manhattan(ex.pos, ey.pos) > 2 * effHorizon + 2) continue;
          const m = Math.max(this.margin(ex.trust), this.margin(ey.trust));
          const c = this.firstConflict(cutOf(ex.id), cutOf(ey.id), m);
          if (!c) continue;
          // keep the original orientation: a = the robot earlier in my view (me first)
          const lo = idxOf.get(ex.id)! < idxOf.get(ey.id)!;
          conflicts.push({ a: lo ? ex.id : ey.id, b: lo ? ey.id : ex.id, cell: c.cell, t: c.t });
          if (!seen.has(ey.id)) {
            seen.add(ey.id);
            q.push(ey.id);
          }
        }
      }
      // same evaluation order as the full pairwise scan (view order: me first, then peers)
      conflicts.sort((p, q2) => idxOf.get(p.a)! - idxOf.get(q2.a)! || idxOf.get(p.b)! - idxOf.get(q2.b)!);
    }
    const inCluster = new Set(cluster);
    this.stats.clusterSum += cluster.length;
    this.stats.clusterN += 1;

    // ---- Congestion & uncertainty fields (γ and ζ terms).
    // Congestion = predicted traffic density from everyone's desired paths; each
    // planner sees the field minus its own contribution (so replicas match exactly).
    const congAll = new Float32Array(this.map.n);
    const addPath = (arr: Float32Array, d: Cell[], sign: number) => {
      for (let t = 1; t <= H; t++) if (d[t] >= 0) arr[d[t]] += sign * (1 - t / (H + 1));
    };
    for (const e of entries) addPath(congAll, desired.get(e.id)!, 1);
    const congFor = (id: number): Float32Array => {
      const c = congAll.slice();
      addPath(c, desired.get(id)!, -1);
      return c;
    };
    const cong = congFor(this.id);
    // Uncertainty = proximity to hazards (stale / isolated / unseen robots) — shared knowledge.
    const unc = new Float32Array(this.map.n);
    for (const cells of hazards.values()) for (const c of cells) for (const nb of this.map.nbrs[c]) unc[nb] += 0.5;
    for (const e of entries) {
      if (e.trust < 0.9) {
        const u = 1 - e.trust;
        unc[e.pos] += u;
        for (const nb of this.map.nbrs[e.pos]) unc[nb] += u * 0.5;
      }
    }

    // ---- DECIDE: precedence for every conflicting pair in my cluster.
    const baseRt = this.baseTable(entries, protectedCells);
    const precedence: PrecedenceRecord[] = [];
    const clusterConflicts = conflicts.filter((c) => inCluster.has(c.a) && inCluster.has(c.b));
    const liveKeys = new Set<string>();
    let evaluations = 0;
    for (const c of clusterConflicts) {
      const ea = byId.get(c.a)!;
      const eb = byId.get(c.b)!;
      const key = ea.id < eb.id ? `${ea.id}-${eb.id}` : `${eb.id}-${ea.id}`;
      liveKeys.add(key);
      const rec = this.decidePair(ea, eb, c, baseRt, desired, entries, evaluations < 28);
      if (rec.basis === 'fleet-cost') evaluations++;
      precedence.push(rec);
    }
    // A decision survives brief gaps in the conflict (e.g. one robot stepping into a
    // side pocket); it is forgotten only after the pair has stopped interacting for a while.
    for (const k of Array.from(this.precedenceMemo.keys())) {
      const r = this.precedenceMemo.get(k)!;
      if (liveKeys.has(k)) r.seen = this.t;
      else if (this.t - (r.seen ?? r.since) > 12) this.precedenceMemo.delete(k);
    }

    // ---- Order: topological sort of precedence (winner before loser), ties by effective priority.
    const order = this.orderCluster(cluster, precedence, byId);

    // ---- RESERVE: sequentially plan the cluster up to me on a shared space-time table.
    const rt = baseRt;
    const margins = new Map<number, number>();
    for (const e of entries) margins.set(e.id, this.margin(e.trust));
    // Robots outside my cluster keep their own announced intents (independent traffic flows freely).
    for (const e of entries) {
      if (e.self || inCluster.has(e.id) || e.fixed) continue;
      if (a.useReservations) {
        const ann = e.announced.length ? e.announced : desired.get(e.id)!;
        const arr = ann.indexOf(e.goal);
        rt.reservePath(ann, e.id, margins.get(e.id)!, arr >= 0 ? arr + e.hold : H);
      }
      else rt.reserve(e.announced[1] ?? e.pos, 1, e.id);
    }
    const replicated = new Map<number, Cell[]>();
    let myPlan: Cell[] | null = null;
    let expanded = 0;
    const K = this.K();
    const prefix = me.announced.slice(0, K + 1);
    while (prefix.length < K + 1) prefix.push(prefix[prefix.length - 1] ?? this.pos);
    for (const id of order) {
      const e = byId.get(id)!;
      if (e.fixed) continue;
      if (e.self) {
        if (this.routeGoal !== this.goal) {
          this.prevRoute = new Set();
          this.routeGoal = this.goal;
        }
        // My first K steps are already promised; plan the rest from the end of the prefix.
        // Route-switch penalty uses exactly what peers use for me: my last signed intent.
        const lastSig = this.sentPlans.get(this.t - 1);
        this.prevRoute = lastSig ? new Set(lastSig.slice(1)) : new Set();
        const lockedAtK = e.mv > 1 && prefix[K] !== prefix[K - 1];
        const res = this.sta({ ...e, pos: prefix[K] }, rt, { cong, unc, prev: this.prevRoute }, K, lockedAtK);
        expanded += res?.expanded ?? 0;
        if (res) {
          myPlan = res.timed.slice();
          for (let i = 0; i <= K; i++) myPlan[i] = prefix[i];
        }
        break;
      }
      if (!a.useReservations) {
        rt.reserve(desired.get(id)![1], 1, id);
        continue;
      }
      const pre = e.announced.slice(0, K + 1);
      const res = this.sta({ ...e, pos: pre[K] ?? e.pos }, rt, { cong: congFor(id), unc, prev: new Set(e.announced) }, K, e.mv > 1 && pre.length > K && pre[K] !== pre[K - 1]);
      expanded += res?.expanded ?? 0;
      const planE = res ? res.timed.slice() : new Array(H + 1).fill(e.pos);
      for (let i = 0; i <= K && i < pre.length; i++) planE[i] = pre[i];
      replicated.set(id, planE);
      rt.reservePath(planE, id, margins.get(id)!, res ? res.holdEnd : H);
    }
    this.debug.staExpanded = expanded;
    this.debug.replicated = replicated;

    const log = new Map<number, Cell>();
    for (const [id, p] of replicated) log.set(id, p[1]);
    this.replicaLog.set(this.t, log);
    for (const k of this.replicaLog.keys()) if (k < this.t - 10) this.replicaLog.delete(k);

    if (!myPlan) {
      myPlan = new Array(H + 1).fill(prefix[K]);
      for (let i = 0; i <= K; i++) myPlan[i] = prefix[i];
    }
    this.plan = myPlan;

    // ---- EXECUTE through the right-of-way gate (Level 2, provably collision-free).
    let next = prefix[1];
    let action: Action = 'GO';
    let reason = '';
    let yieldTo = -1;
    if (next !== this.pos) {
      const g = this.gate(next, sense);
      if (!g.ok) {
        this.stats.safetyHolds++;
        next = this.pos;
        action = 'HOLD';
        yieldTo = g.blocker;
        reason = g.reason;
        // My remaining promises are void; re-plan from where I actually am.
        const res = this.sta({ ...me, pos: this.pos }, rt, { cong, unc, prev: this.prevRoute }, K);
        const stay = res ? res.timed.slice() : new Array(H + 1).fill(this.pos);
        for (let i = 0; i <= K; i++) stay[i] = this.pos;
        this.plan = this.sanitize(stay);
      }
    } else if (myPlan[1] === this.pos && myPlan[K + 1] !== undefined && myPlan[K + 1] !== this.pos && K > 0 && prefix.every((c) => c === this.pos)) {
      action = 'HOLD';
      reason = `Commit: announcing intent via ${this.map.label(myPlan[K + 1])} ${K} tick${K > 1 ? 's' : ''} before moving (peers must see it first)`;
      this.stats.commitHolds++;
    }
    if (!reason) {
      const myDes = desired.get(this.id)!;
      const wantMove = myDes[1] !== this.pos;
      const routeCells = new Set(myPlan);
      const offRoute = this.prevRoute.size > 0 && next !== this.pos && !this.prevRoute.has(next) && this.routeGoal === this.goal;
      if (next === this.pos && wantMove) {
        // Who owns the cell I wanted?
        const blocker = rt.owner(myDes[1], 1) >= 0 ? rt.owner(myDes[1], 1) : rt.owner(myDes[Math.min(2, H)], 2);
        const recs = precedence.filter((r) => (r.a === this.id || r.b === this.id) && r.winner !== this.id);
        if (recs.length > 0) {
          const r = recs[0];
          const other = r.a === this.id ? r.b : r.a;
          yieldTo = other;
          action = 'YIELD';
          this.stats.yields++;
          reason = this.explain(r, other);
        } else if (blocker === PROTECTED) {
          action = 'WAIT';
          reason = 'Waiting: path runs through a protected (uncertain / blocked) zone';
        } else if (blocker >= 0) {
          yieldTo = blocker;
          action = 'YIELD';
          this.stats.yields++;
          reason = `Yield: R${blocker + 1} holds the space-time slot I need`;
        } else {
          action = 'WAIT';
          this.stats.waits++;
          reason = 'Waiting: best fleet plan has me pause this tick';
        }
      } else if (offRoute && this.t - this.routeSince >= 0) {
        action = 'REROUTE';
        this.stats.reroutes++;
        const why = protectedCells.size > 0 || this.blocked.size > 0 ? 'avoiding protected / blocked cells' : 'lower fleet cost via alternate aisle';
        reason = `Re-route: ${why} (route change penalty δ paid)`;
        this.ev('reroute', `${this.name} re-routes ${this.map.label(this.pos)} → ${this.map.label(this.goal)}: ${why}`, this.pos, `rr:${this.id}:${this.t}`);
        this.prevRoute = routeCells;
        this.routeSince = this.t;
      } else if (next === this.pos) {
        action = this.goal === this.pos ? 'WAIT' : 'WAIT';
        reason = this.goal === this.pos ? (this.mode === 'IDLE' ? 'Parked at home bay' : 'At goal') : 'Waiting';
      } else {
        action = 'GO';
        const cl = cluster.length > 1 ? ` · coordinating with ${cluster.filter((x) => x !== this.id).map((x) => `R${x + 1}`).join(', ')}` : ' · no interacting peers';
        reason = `Go → ${this.map.label(this.goal)} (ETA ${this.etaOf(myPlan)} ticks)${cl}`;
      }
      if (next !== this.pos && (this.prevRoute.size === 0 || !this.prevRoute.has(next))) this.prevRoute = routeCells;
      // keep the committed route fresh as the robot advances along it
      if (action === 'GO') for (const c of routeCells) this.prevRoute.add(c);
    }

    // Explainability: report the start of every yield with its reasoning.
    if (action === 'YIELD' && (this.lastAction !== 'YIELD' || this.lastYieldTo !== yieldTo) && yieldTo >= 0) {
      this.ev('yield', `${this.name} → ${reason}`, this.pos, `y:${this.id}:${yieldTo}:${this.t}`);
    }
    this.lastAction = action;
    this.lastYieldTo = yieldTo;
    this.debug.cluster = cluster;
    this.debug.order = order;
    this.debug.conflicts = conflicts;
    this.debug.precedence = precedence;
    this.debug.protectedCells = Array.from(protectedCells);
    return { next, action, reason, yieldTo };
  }

  private etaOf(plan: Cell[]): number {
    const i = plan.indexOf(this.goal);
    if (i >= 0) return i;
    const last = plan[plan.length - 1];
    return plan.length - 1 + this.dist(last, this.goal);
  }

  private explain(r: PrecedenceRecord, other: number): string {
    const o = `R${other + 1}`;
    if (r.basis === 'fixed') return `Yield to ${o}: it is servicing a station at ${this.map.label(r.cell)}`;
    if (r.basis === 'priority') return `Yield to ${o} at ${this.map.label(r.cell)}: higher effective priority (fleet cost disabled)`;
    const mine = r.a === this.id ? r.costAFirst : r.costBFirst; // fleet cost if I go first
    const theirs = r.a === this.id ? r.costBFirst : r.costAFirst; // fleet cost if they go first
    const myDelay = r.a === this.id ? r.delayA : r.delayB;
    return `Yield to ${o} at ${this.map.label(r.cell)}: fleet cost ${o}-first ${theirs.toFixed(1)} < me-first ${mine.toFixed(1)} (my delay +${myDelay.toFixed(0)} ticks)${r.basis === 'held' ? ' · decision held (min-commit)' : ''}`;
  }

  /**
   * Fleet-wide cost of letting `first` pass before `second`:
   *   J = β · w₂ · Δ₂ · (1 + ε·age₂) + γ · downstream₂ · Δ₂ + ζ · (1 − trust₁)
   * Δ₂ comes from actually re-planning `second` around `first` with Space-Time A*.
   */
  private decidePair(ea: Entry, eb: Entry, c: { cell: Cell; t: number }, baseRt: ReservationTable, desired: Map<number, Cell[]>, entries: Entry[], allowEval: boolean): PrecedenceRecord {
    const a = this.algo;
    const key = ea.id < eb.id ? `${ea.id}-${eb.id}` : `${eb.id}-${ea.id}`;
    const mk = (winner: number, basis: PrecedenceRecord['basis'], cA = 0, cB = 0, dA = 0, dB = 0): PrecedenceRecord => ({
      a: ea.id, b: eb.id, winner, cell: c.cell, t: c.t, costAFirst: cA, costBFirst: cB, delayA: dA, delayB: dB, since: this.t, basis,
    });
    if (ea.fixed !== eb.fixed) return mk(ea.fixed ? ea.id : eb.id, 'fixed');
    // Shared station (same goal cell): queue discipline — accumulated waiting dominates,
    // so a robot can never be overtaken at a station indefinitely (bounded fairness).
    if (ea.goal === eb.goal && a.useFairness && ea.goal !== ea.pos && eb.goal !== eb.pos) {
      const qa = ea.weight * (1 + 0.25 * ea.wait) - this.map.manhattan(ea.pos, ea.goal) * 0.01;
      const qb = eb.weight * (1 + 0.25 * eb.wait) - this.map.manhattan(eb.pos, eb.goal) * 0.01;
      let prevQ = this.precedenceMemo.get(key);
      if (prevQ) {
        // Re-open the queue slot if its holder stopped making progress (blocked elsewhere).
        const holder = prevQ.winner === ea.id ? ea : prevQ.winner === eb.id ? eb : null;
        if (!holder || (prevQ.winnerWait !== undefined && holder.wait - prevQ.winnerWait >= 6)) {
          this.precedenceMemo.delete(key);
          prevQ = undefined;
        }
      }
      const w = prevQ ? prevQ.winner : qa > qb || (qa === qb && ea.id < eb.id) ? ea.id : eb.id;
      const rec = mk(w, prevQ ? 'held' : 'priority');
      if (!prevQ) {
        rec.winnerWait = (w === ea.id ? ea : eb).wait;
        this.precedenceMemo.set(key, rec);
      }
      return rec;
    }
    const byPriority = () => (ea.eff > eb.eff || (ea.eff === eb.eff && ea.id < eb.id) ? ea.id : eb.id);
    if (!a.useFleetCost || !allowEval) return mk(byPriority(), 'priority');

    const etaDesired = (e: Entry) => this.field(e.goal)[e.pos] * e.mv;
    const delayAround = (mover: Entry, first: Entry): number => {
      const rt = baseRt.clone();
      rt.reservePath(desired.get(first.id)!, first.id, this.margin(first.trust));
      const r = this.sta(mover, rt);
      if (!r) return a.horizon * 2;
      return Math.max(0, r.eta - Math.min(etaDesired(mover), 1e6));
    };
    const downstream = (e: Entry): number => {
      // How many other robots will want e's current cell soon (it blocks them if it waits)?
      let n = 0;
      for (const o of entries) {
        if (o.id === e.id || o.id === ea.id || o.id === eb.id) continue;
        const d = desired.get(o.id)!;
        for (let t = 1; t <= Math.min(6, d.length - 1); t++) if (d[t] === e.pos) {
          n++;
          break;
        }
      }
      return n;
    };
    const dB = delayAround(eb, ea); // B's delay if A goes first
    const dA = delayAround(ea, eb);
    const fair = (e: Entry) => (a.useFairness ? 1 + a.wFairness * e.wait : 1);
    const unc = (e: Entry) => (a.useTrust ? a.wUncertainty * (1 - e.trust) : 0);
    const costAFirst = a.wDelay * eb.weight * dB * fair(eb) + a.wCongestion * downstream(eb) * dB + unc(ea);
    const costBFirst = a.wDelay * ea.weight * dA * fair(ea) + a.wCongestion * downstream(ea) * dA + unc(eb);
    let winner: number;
    if (Math.abs(costAFirst - costBFirst) < 1e-6) winner = byPriority();
    else winner = costAFirst < costBFirst ? ea.id : eb.id;

    // Commitment: a decision is kept for the whole life of the conflict. It is only
    // re-opened (a) during the first tick it exists (no memory yet), or (b) when the
    // winner itself stops making progress (blocked by a third robot), because then
    // the decision can no longer be executed. Fresh cost noise never flips it —
    // flipping is exactly what makes two robots dance in a single-lane aisle.
    const prev = this.precedenceMemo.get(key);
    let basis: PrecedenceRecord['basis'] = 'fleet-cost';
    if (prev) {
      const w = prev.winner === ea.id ? ea : prev.winner === eb.id ? eb : null;
      const stuck = w !== null && prev.winnerWait !== undefined && w.wait - prev.winnerWait >= Math.max(6, a.minCommit + 2);
      if (!stuck && prev.winner !== winner) {
        winner = prev.winner;
        basis = 'held';
      } else if (!stuck) basis = prev.basis === 'held' ? 'held' : 'fleet-cost';
    }
    const rec = mk(winner, basis, costAFirst, costBFirst, dA, dB);
    const winnerEntry = winner === ea.id ? ea : eb;
    if (!prev || prev.winner !== winner) {
      rec.winnerWait = winnerEntry.wait;
      this.precedenceMemo.set(key, rec);
    } else {
      rec.since = prev.since;
      rec.winnerWait = prev.winnerWait;
      prev.costAFirst = costAFirst;
      prev.costBFirst = costBFirst;
    }
    return rec;
  }

  private orderCluster(cluster: number[], prec: PrecedenceRecord[], byId: Map<number, Entry>): number[] {
    const indeg = new Map<number, number>();
    const out = new Map<number, number[]>();
    for (const id of cluster) {
      indeg.set(id, 0);
      out.set(id, []);
    }
    for (const r of prec) {
      const loser = r.winner === r.a ? r.b : r.a;
      if (!indeg.has(loser) || !indeg.has(r.winner)) continue;
      out.get(r.winner)!.push(loser);
      indeg.set(loser, indeg.get(loser)! + 1);
    }
    const rank = (id: number) => {
      const e = byId.get(id)!;
      return (e.fixed ? 1000 : 0) + e.eff;
    };
    const order: number[] = [];
    const remaining = new Set(cluster);
    while (remaining.size) {
      let pick = -1;
      for (const id of remaining) {
        if (indeg.get(id)! > 0) continue;
        if (pick < 0 || rank(id) > rank(pick) || (rank(id) === rank(pick) && id < pick)) pick = id;
      }
      if (pick < 0) {
        // Precedence cycle: break it deterministically by effective priority.
        for (const id of remaining) if (pick < 0 || rank(id) > rank(pick) || (rank(id) === rank(pick) && id < pick)) pick = id;
      }
      order.push(pick);
      remaining.delete(pick);
      for (const y of out.get(pick)!) indeg.set(y, indeg.get(y)! - 1);
    }
    return order;
  }

  // =====================================================================
  // Outgoing intent
  // =====================================================================
  isolating(): number[] {
    const out: number[] = [];
    for (const p of this.peers.values()) if (p.health === 'ISOLATED') out.push(p.id);
    return out;
  }

  private buildHeartbeat(): Heartbeat {
    const H = this.algo.horizon;
    let plan = this.plan.slice(0, H + 1);
    if (plan.length === 0 || plan[0] !== this.pos) plan = [this.pos, ...plan.filter((_, i) => i > 0)];
    while (plan.length < Math.max(Math.min(H + 1, 4), this.K() + 2)) plan.push(plan[plan.length - 1]);
    const health: Heartbeat['health'] = this.mode === 'FAULT' ? 'FAULT' : this.moveTicks > 1 ? 'DEGRADED' : 'OK';
    const hb = this.baseHeartbeat(plan, this.myBids(), this.isolating(), health);
    for (const r of this.debug.precedence) {
      if (r.a !== this.id && r.b !== this.id) continue;
      hb.prec.push([r.winner, r.winner === r.a ? r.b : r.a]);
    }
    if (this.compromised) return this.forge(hb);
    return hb;
  }

  /**
   * Compromised firmware (valid key, malicious content): hogs the central
   * junctions with a fake intent, forges its position and under-bids every task.
   */
  private forge(hb: Heartbeat): Heartbeat {
    const js = this.map.junctions;
    const cx = this.map.width / 2;
    const cy = this.map.height / 2;
    const central = js
      .slice()
      .sort((p, q) => Math.hypot(this.map.x(p) - cx, this.map.y(p) - cy) - Math.hypot(this.map.x(q) - cx, this.map.y(q) - cy))
      .slice(0, 6);
    hb.plan = [hb.pos, ...central, ...central].slice(0, this.algo.horizon + 1);
    if (this.seq % 4 === 0) {
      const far = this.map.homes[(this.seq * 7) % Math.max(1, this.map.homes.length)] ?? hb.pos;
      hb.pos = far;
      hb.plan[0] = far;
    }
    hb.bids = Array.from(this.tasks.values())
      .filter((r) => r.status === 'open')
      .slice(0, 6)
      .map((r) => [r.id, 0] as [string, number]);
    return hb;
  }

  /** Belief snapshot for the "robot's-eye view" in the twin. */
  beliefs(): { id: number; health: PeerHealth; trust: number; pos: Cell; age: number; plan: Cell[] }[] {
    return Array.from(this.peers.values()).map((p) => ({
      id: p.id,
      health: p.health,
      trust: p.trust,
      pos: p.hb ? p.hb.pos : p.credPos,
      age: p.lastHeard < 0 ? 999 : this.t - p.lastHeard,
      plan: p.hb ? p.hb.plan : [],
    }));
  }
}

export type { AgentEvent, Priority };
