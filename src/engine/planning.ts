import type { WarehouseMap } from './grid';
import type { Cell } from './types';

export const INF = 1 << 29;

// ---------------------------------------------------------------------------
// Distance fields (exact heuristic): BFS from the goal over the static map minus
// the cells a robot currently *knows* to be blocked. Pure function of
// (map, blocked set, goal) -> memoised globally so identical robots share work.
// ---------------------------------------------------------------------------

const fieldCache = new Map<string, Int32Array>();

export function blockedKey(blocked: ReadonlySet<Cell>): string {
  if (blocked.size === 0) return '';
  return Array.from(blocked).sort((a, b) => a - b).join('.');
}

export function distanceField(map: WarehouseMap, goal: Cell, blocked: ReadonlySet<Cell>, bKey?: string): Int32Array {
  const key = `${map.width}x${map.height}:${bKey ?? blockedKey(blocked)}:${goal}`;
  const hit = fieldCache.get(key);
  if (hit) return hit;
  const d = new Int32Array(map.n).fill(INF);
  if (map.walkable(goal) && !blocked.has(goal)) {
    const q = new Int32Array(map.n);
    let head = 0;
    let tail = 0;
    d[goal] = 0;
    q[tail++] = goal;
    while (head < tail) {
      const c = q[head++];
      const nb = map.nbrs[c];
      const nd = d[c] + 1;
      for (let i = 0; i < nb.length; i++) {
        const m = nb[i];
        if (d[m] > nd && !blocked.has(m)) {
          d[m] = nd;
          q[tail++] = m;
        }
      }
    }
  }
  if (fieldCache.size > 4000) fieldCache.clear();
  fieldCache.set(key, d);
  return d;
}

export function resetPlanningCaches(): void {
  fieldCache.clear();
}

/** Shortest spatial path (list of cells incl. start) by descending the distance field. */
export function spatialPath(map: WarehouseMap, start: Cell, goal: Cell, field: Int32Array, maxLen = 4096): Cell[] | null {
  if (field[start] >= INF) return null;
  const path = [start];
  let c = start;
  let prevDir = 0;
  while (c !== goal && path.length < maxLen) {
    const nb = map.nbrs[c];
    let best = -1;
    let bestScore = INF;
    for (let i = 0; i < nb.length; i++) {
      const m = nb[i];
      const dm = field[m];
      if (dm >= field[c]) continue;
      // Prefer keeping the current heading (fewer turns = less energy); deterministic tiebreak.
      const dir = m - c;
      const score = dm * 4 + (dir === prevDir ? 0 : 1);
      if (score < bestScore) {
        bestScore = score;
        best = m;
      }
    }
    if (best < 0) return null;
    prevDir = best - c;
    c = best;
    path.push(c);
  }
  return c === goal ? path : null;
}

/** Expand a spatial path into a timed occupancy sequence of length horizon+1. */
export function timePath(path: Cell[], horizon: number, moveTicks = 1): Cell[] {
  const out: Cell[] = new Array(horizon + 1);
  let t = 0;
  out[0] = path[0];
  let i = 0;
  while (t < horizon) {
    if (i + 1 < path.length) {
      // a degraded drive needs moveTicks-1 recovery ticks after each move (matches physics)
      out[++t] = path[++i];
      for (let d = 1; d < moveTicks && t < horizon; d++) out[++t] = path[i];
    } else {
      out[++t] = path[path.length - 1];
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Space-time reservation table: (cell, t) -> robot id. The same physical cell can
// serve several robots at different times. Permanent entries model hazards and
// "unknown is not free" protection zones.
// ---------------------------------------------------------------------------

export const PROTECTED = -2;
const FREE = -1;

export class ReservationTable {
  readonly n: number;
  readonly horizon: number;
  readonly v: Int16Array;
  readonly perm: Int16Array;

  constructor(n: number, horizon: number) {
    this.n = n;
    this.horizon = horizon;
    this.v = new Int16Array((horizon + 1) * n).fill(FREE);
    this.perm = new Int16Array(n).fill(FREE);
  }

  clone(): ReservationTable {
    const r = new ReservationTable(this.n, this.horizon);
    r.v.set(this.v);
    r.perm.set(this.perm);
    return r;
  }

  reserve(cell: Cell, t: number, id: number): void {
    if (t < 0 || t > this.horizon) return;
    const k = t * this.n + cell;
    if (this.v[k] === FREE) this.v[k] = id;
  }

  reservePerm(cell: Cell, id: number): void {
    if (this.perm[cell] === FREE) this.perm[cell] = id;
  }

  /** Reserve a timed path; `margin` pads each occupancy window by +/- margin ticks. */
  reservePath(timed: Cell[], id: number, margin = 0, until = Infinity): void {
    const H = this.horizon;
    const end = Math.min(H, until);
    for (let t = 0; t < timed.length && t <= end; t++) {
      const c = timed[t];
      if (c < 0) break;
      for (let d = -margin; d <= margin; d++) this.reserve(c, t + d, id);
    }
    // Beyond its plan (and inside its hold window) the robot sits at its last cell.
    const last = timed[Math.min(timed.length, H + 1) - 1];
    if (last >= 0) for (let t = timed.length; t <= end; t++) this.reserve(last, t, id);
  }

  owner(cell: Cell, t: number): number {
    const p = this.perm[cell];
    if (p !== FREE) return p;
    if (t < 0 || t > this.horizon) return FREE;
    return this.v[t * this.n + cell];
  }

  isFree(cell: Cell, t: number, self: number): boolean {
    const o = this.owner(cell, t);
    return o === FREE || o === self;
  }

  /** Moving a -> b between t-1 and t swaps with a robot doing b -> a. */
  swapConflict(a: Cell, b: Cell, t: number, self: number): boolean {
    if (t < 1 || t > this.horizon) return false;
    const ob = this.v[(t - 1) * this.n + b];
    if (ob === FREE || ob === self || ob === PROTECTED) return false;
    return this.v[t * this.n + a] === ob;
  }
}

// ---------------------------------------------------------------------------
// Space-Time A* — cooperative pathfinding (Silver 2005) extended with the ANVAYA
// cost terms. State = (cell, t), actions = {wait, move N/E/S/W}.
//   step cost = β·Δt + η·energy + γ·congestion(cell) + ζ·uncertainty(cell) + δ·offRoute
// Terminal cost at the horizon = β · distance-to-goal (exact, from the field).
// ---------------------------------------------------------------------------

export interface StaInput {
  map: WarehouseMap;
  start: Cell;
  goal: Cell;
  self: number;
  horizon: number;
  rt: ReservationTable;
  field: Int32Array;
  blocked: ReadonlySet<Cell>;
  moveTicks: number;
  wDelay: number;
  wEnergy: number;
  wCongestion: number;
  wUncertainty: number;
  wReplan: number;
  congestion?: Float32Array | null;
  uncertainty?: Float32Array | null;
  /** Cells of the previously committed route (route-switch penalty / hysteresis). */
  prevRoute?: ReadonlySet<Cell> | null;
  /** Hold still for the first `dwell` ticks (servicing). */
  dwell?: number;
  /** Ticks the robot must be able to stay at its goal after arrival (service dwell); default = rest of horizon. */
  goalHold?: number;
  /** Search starts at (start, startT): ticks before startT are an already-committed prefix. */
  startT?: number;
  /** A degraded drive that just moved must recover one tick before its next move. */
  startLocked?: boolean;
}

export interface StaResult {
  timed: Cell[];
  cost: number;
  /** Estimated ticks until the goal is reached (arrival time, or horizon + remaining distance). */
  eta: number;
  reached: boolean;
  expanded: number;
  /** Last tick this plan needs reserved (arrival + goal hold, or the horizon). */
  holdEnd: number;
}

class MinHeap {
  private keys: number[] = [];
  private vals: number[] = [];
  get size(): number {
    return this.keys.length;
  }
  push(key: number, val: number): void {
    const k = this.keys;
    const v = this.vals;
    k.push(key);
    v.push(val);
    let i = k.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p];
      v[i] = v[p];
      i = p;
    }
    k[i] = key;
    v[i] = val;
  }
  pop(): number {
    const k = this.keys;
    const v = this.vals;
    const top = v[0];
    const lk = k.pop() as number;
    const lv = v.pop() as number;
    const n = k.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && k[r] < k[l] ? r : l;
        if (k[c] >= lk) break;
        k[i] = k[c];
        v[i] = v[c];
        i = c;
      }
      k[i] = lk;
      v[i] = lv;
    }
    return top;
  }
}

// Pooled search buffers with generation stamps: no per-call allocation or O(S)
// clearing (a 48×48 map with H=16 has ~78k states per search).
const pool = { size: 0, g: new Float64Array(0), parent: new Int32Array(0), closed: new Uint8Array(0), stamp: new Uint32Array(0), gen: 0 };
function acquire(S: number) {
  if (pool.size < S) {
    pool.size = S;
    pool.g = new Float64Array(S);
    pool.parent = new Int32Array(S);
    pool.closed = new Uint8Array(S);
    pool.stamp = new Uint32Array(S);
    pool.gen = 0;
  }
  pool.gen = (pool.gen + 1) >>> 0;
  if (pool.gen === 0) {
    pool.stamp.fill(0);
    pool.gen = 1;
  }
  return pool;
}

export function spaceTimeAStar(inp: StaInput): StaResult | null {
  const { map, start, goal, self, horizon: H, rt, field, blocked, moveTicks } = inp;
  const N = map.n;
  // State = (t, cell, lock). lock=1 means a degraded drive must recover this tick.
  const S = (H + 1) * N * 2;
  const P = acquire(S);
  const gen = P.gen;
  const G = P.g;
  const PAR = P.parent;
  const CL = P.closed;
  const ST = P.stamp;
  const touch = (x: number) => {
    if (ST[x] !== gen) {
      ST[x] = gen;
      G[x] = Infinity;
      PAR[x] = -1;
      CL[x] = 0;
    }
  };
  const gOf = (x: number) => (ST[x] === gen ? G[x] : Infinity);
  const heap = new MinHeap();
  const cong = inp.congestion;
  const unc = inp.uncertainty;
  const prev = inp.prevRoute;
  const dwell = inp.dwell ?? 0;
  const slow = moveTicks > 1;
  const EPS = 1e-4;
  const T0 = Math.min(inp.startT ?? 0, H);
  const key = (t: number, c: number, l: number) => ((t * N + c) << 1) | l;
  const s0 = key(T0, start, slow && inp.startLocked ? 1 : 0);
  touch(s0);
  G[s0] = 0;
  heap.push(inp.wDelay * Math.min(field[start], INF / 2), s0);
  let expanded = 0;
  let bestTerminal = -1;
  let bestTerminalCost = Infinity;

  const hold = inp.goalHold ?? H;
  const goalFreeUntilH = (t: number): boolean => {
    const end = Math.min(H, t + hold);
    for (let u = t; u <= end; u++) if (!rt.isFree(goal, u, self)) return false;
    return true;
  };

  while (heap.size > 0) {
    const s = heap.pop();
    touch(s);
    if (CL[s]) continue;
    CL[s] = 1;
    expanded++;
    const l = s & 1;
    const tc = s >> 1;
    const t = (tc / N) | 0;
    const c = tc - t * N;
    const gs = G[s];

    if (c === goal && t >= dwell && goalFreeUntilH(t)) {
      bestTerminal = s;
      bestTerminalCost = gs;
      break;
    }
    if (t === H) {
      const term = gs + inp.wDelay * field[c] * moveTicks;
      if (term < bestTerminalCost) {
        bestTerminalCost = term;
        bestTerminal = s;
      }
      continue;
    }
    if (gs + inp.wDelay * field[c] > bestTerminalCost) continue;

    // --- wait (also the forced recovery tick of a degraded drive) ---
    {
      const t2 = t + 1;
      const ok = (t === T0 && c === start) || (rt.isFree(c, t2, self) && (t2 >= H || rt.isFree(c, t2 + 1, self)));
      if (ok) {
        const s2 = key(t2, c, 0);
        const atGoal = c === goal && t >= dwell && goalFreeUntilH(t2);
        const cost = gs + (atGoal ? 0 : inp.wDelay + (0.02 * (H - t)) / H) + inp.wEnergy * 0.2 - EPS * t2;
        if (cost < gOf(s2)) {
          touch(s2);
          G[s2] = cost;
          PAR[s2] = s;
          heap.push(cost + inp.wDelay * field[c] * moveTicks, s2);
        }
      }
    }
    if (t < dwell || l === 1) continue;

    // --- move actions ---
    const nb = map.nbrs[c];
    const t2 = t + 1;
    for (let i = 0; i < nb.length; i++) {
      const m = nb[i];
      if (blocked.has(m)) continue;
      if (field[m] >= INF) continue;
      if (!rt.isFree(m, t2, self)) continue;
      if (t2 < H && !rt.isFree(m, t2 + 1, self)) continue;
      // Headway rule (matches the onboard gate): never enter a cell another robot
      // occupies at the start of the move — no same-tick following, no swaps.
      const before = rt.owner(m, t2 - 1);
      if (before >= 0 && before !== self) continue;
      if (rt.swapConflict(c, m, t2, self)) continue;
      const s2 = key(t2, m, slow ? 1 : 0);
      let extra = inp.wEnergy;
      if (cong) extra += inp.wCongestion * cong[m];
      if (unc) extra += inp.wUncertainty * unc[m];
      if (prev && prev.size > 0 && !prev.has(m)) extra += inp.wReplan * 0.5;
      // Soft terms are capped at 0.9β so progress always beats procrastination.
      const step = inp.wDelay + Math.min(extra, 0.9 * inp.wDelay);
      const cost = gs + step - EPS * t2;
      if (cost < gOf(s2)) {
        touch(s2);
        G[s2] = cost;
        PAR[s2] = s;
        heap.push(cost + inp.wDelay * field[m] * moveTicks, s2);
      }
    }
  }

  if (bestTerminal < 0) return null;

  const chain: number[] = [];
  let s = bestTerminal;
  while (s >= 0) {
    chain.push(s);
    s = ST[s] === gen ? PAR[s] : -1;
  }
  chain.reverse();
  const timed: Cell[] = new Array(H + 1).fill(start);
  for (const st of chain) {
    const tc = st >> 1;
    const t = (tc / N) | 0;
    timed[t] = tc - t * N;
  }
  const endTc = bestTerminal >> 1;
  const endT = (endTc / N) | 0;
  const endC = endTc - endT * N;
  for (let t = endT + 1; t <= H; t++) timed[t] = endC;
  let reachT = -1;
  for (let t = 0; t <= H; t++) {
    if (timed[t] === goal) {
      reachT = t;
      break;
    }
  }
  const reached = endC === goal;
  const eta = reached && reachT >= 0 ? reachT : H + field[endC] * moveTicks;
  const holdEnd = reached ? Math.min(H, endT + hold) : H;
  return { timed, cost: bestTerminalCost, eta, reached, expanded, holdEnd };
}
