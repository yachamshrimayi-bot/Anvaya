import { Cell, CellKind, LayoutKind } from './types';

/**
 * Static warehouse topology. The map is a 4-connected grid graph: nodes are floor
 * cells, edges connect orthogonal neighbours. Racks are non-traversable.
 */
export class WarehouseMap {
  readonly width: number;
  readonly height: number;
  readonly n: number;
  readonly kind: Uint8Array;
  /** Pre-computed walkable neighbours per cell (static map only). */
  readonly nbrs: Int32Array[];
  readonly pickFaces: Cell[] = [];
  readonly drops: Cell[] = [];
  readonly chargers: Cell[] = [];
  readonly homes: Cell[] = [];
  /** Cells with >= 3 walkable neighbours: intersections (useful for analytics). */
  readonly junctions: Cell[] = [];

  constructor(width: number, height: number, kind: Uint8Array) {
    this.width = width;
    this.height = height;
    this.n = width * height;
    this.kind = kind;
    this.nbrs = new Array(this.n);
    for (let c = 0; c < this.n; c++) {
      const out: number[] = [];
      if (kind[c] !== CellKind.Rack) {
        const x = c % width;
        const y = (c / width) | 0;
        // Fixed neighbour order E, S, W, N keeps every search deterministic.
        if (x + 1 < width && kind[c + 1] !== CellKind.Rack) out.push(c + 1);
        if (y + 1 < height && kind[c + width] !== CellKind.Rack) out.push(c + width);
        if (x - 1 >= 0 && kind[c - 1] !== CellKind.Rack) out.push(c - 1);
        if (y - 1 >= 0 && kind[c - width] !== CellKind.Rack) out.push(c - width);
      }
      this.nbrs[c] = Int32Array.from(out);
    }
    for (let c = 0; c < this.n; c++) {
      const k = kind[c];
      if (k === CellKind.Rack) continue;
      if (k === CellKind.Drop) this.drops.push(c);
      else if (k === CellKind.Charger) this.chargers.push(c);
      else if (k === CellKind.Home) this.homes.push(c);
      if (this.nbrs[c].length >= 3) this.junctions.push(c);
      if (k === CellKind.Floor && this.touchesRack(c)) this.pickFaces.push(c);
    }
  }

  x(c: Cell): number {
    return c % this.width;
  }
  y(c: Cell): number {
    return (c / this.width) | 0;
  }
  idx(x: number, y: number): Cell {
    return y * this.width + x;
  }
  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }
  walkable(c: Cell): boolean {
    return c >= 0 && c < this.n && this.kind[c] !== CellKind.Rack;
  }
  manhattan(a: Cell, b: Cell): number {
    return Math.abs(this.x(a) - this.x(b)) + Math.abs(this.y(a) - this.y(b));
  }
  adjacent(a: Cell, b: Cell): boolean {
    return this.manhattan(a, b) === 1;
  }
  label(c: Cell): string {
    return `(${this.x(c)},${this.y(c)})`;
  }
  private touchesRack(c: Cell): boolean {
    const x = this.x(c);
    const y = this.y(c);
    const w = this.width;
    return (
      (x + 1 < w && this.kind[c + 1] === CellKind.Rack) ||
      (x - 1 >= 0 && this.kind[c - 1] === CellKind.Rack) ||
      (y + 1 < this.height && this.kind[c + w] === CellKind.Rack) ||
      (y - 1 >= 0 && this.kind[c - w] === CellKind.Rack)
    );
  }
}

/** Generate a warehouse topology. All layouts are guaranteed fully connected. */
export function buildMap(layout: LayoutKind, width: number, height: number, customRacks?: Cell[]): WarehouseMap {
  const W = Math.max(8, Math.min(48, width | 0));
  const H = Math.max(8, Math.min(48, height | 0));
  const k = new Uint8Array(W * H);
  const set = (x: number, y: number, v: CellKind) => {
    if (x >= 0 && y >= 0 && x < W && y < H) k[y * W + x] = v;
  };

  if (layout === 'custom' && customRacks) {
    for (const c of customRacks) if (c >= 0 && c < W * H) k[c] = CellKind.Rack;
  } else if (layout === 'classic') {
    // Two rack banks with 2-wide aisles, a central spine and a sorter island.
    const bankA = [Math.round(W * 0.15), Math.round(W * 0.38)];
    const bankB = [Math.round(W * 0.6), Math.round(W * 0.83)];
    for (let y = 3; y < H - 3; y += 4) {
      for (const [x0, x1] of [bankA, bankB]) {
        for (let x = x0; x < x1; x++) {
          set(x, y, CellKind.Rack);
          set(x, y + 1, CellKind.Rack);
        }
      }
    }
    const mx = Math.floor(W / 2);
    for (let x = mx - 2; x < mx + 2; x++) {
      set(x, 1, CellKind.Rack);
      set(x, 2, CellKind.Rack);
    }
  } else if (layout === 'crossdock') {
    // Open floor with column pillars — many intersections, few corridors.
    for (let y = 3; y < H - 3; y += 4) {
      for (let x = 3; x < W - 3; x += 4) {
        set(x, y, CellKind.Rack);
        set(x + 1, y, CellKind.Rack);
        set(x, y + 1, CellKind.Rack);
        set(x + 1, y + 1, CellKind.Rack);
      }
    }
  } else if (layout === 'narrow') {
    // Long single-lane aisles: the hardest case for head-on conflicts.
    for (let y = 2; y < H - 2; y += 2) {
      for (let x = 3; x < W - 3; x++) {
        if (x === Math.floor(W / 2)) continue; // one mid cut-through
        set(x, y, CellKind.Rack);
      }
    }
  } else {
    // 'fulfillment' — double-deep rack pairs separated by single-lane pick aisles,
    // cross-aisles every few bays and a 2-lane central cross-aisle.
    const x0 = 3;
    const x1 = W - 4;
    const y0 = 2;
    const y1 = H - 3;
    const midA = Math.floor(H / 2) - 1;
    const midB = midA + 1;
    for (let x = x0; x <= x1; x++) {
      const m = (x - x0) % 3;
      if (m === 2) continue; // single-lane pick aisle
      if (x === x1 && m === 0) continue; // never leave an orphan single rack column
      for (let y = y0; y <= y1; y++) {
        if (y === midA || y === midB) continue;
        if ((y - y0) % 5 === 4) continue; // cross-aisle
        set(x, y, CellKind.Rack);
      }
    }
  }

  // Stations. Drops on the west wall, chargers on the east wall, homes along north/south walls.
  for (let y = 2; y < H - 2; y += 3) if (k[y * W] !== CellKind.Rack) set(0, y, CellKind.Drop);
  const chargerRows = [H - 2, H - 4, H - 6];
  for (const y of chargerRows) if (y > 1) set(W - 1, y, CellKind.Charger);
  for (let x = 2; x < W - 2; x += 2) {
    set(x, 0, CellKind.Home);
    set(x, H - 1, CellKind.Home);
  }

  // Connectivity guarantee: turn every floor cell outside the largest component into rack.
  const n = W * H;
  const comp = new Int32Array(n).fill(-1);
  let best = -1;
  let bestSize = 0;
  let id = 0;
  const q = new Int32Array(n);
  for (let s = 0; s < n; s++) {
    if (k[s] === CellKind.Rack || comp[s] !== -1) continue;
    let head = 0;
    let tail = 0;
    q[tail++] = s;
    comp[s] = id;
    while (head < tail) {
      const c = q[head++];
      const x = c % W;
      const y = (c / W) | 0;
      const cand = [x + 1 < W ? c + 1 : -1, x > 0 ? c - 1 : -1, y + 1 < H ? c + W : -1, y > 0 ? c - W : -1];
      for (const d of cand) {
        if (d >= 0 && k[d] !== CellKind.Rack && comp[d] === -1) {
          comp[d] = id;
          q[tail++] = d;
        }
      }
    }
    if (tail > bestSize) {
      bestSize = tail;
      best = id;
    }
    id++;
  }
  for (let c = 0; c < n; c++) if (k[c] !== CellKind.Rack && comp[c] !== best) k[c] = CellKind.Rack;

  return new WarehouseMap(W, H, k);
}
