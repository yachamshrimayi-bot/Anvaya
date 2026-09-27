/** Deterministic, seedable PRNG (mulberry32). Every run is reproducible from its seed. */
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = (seed >>> 0) ^ 0x9e3779b9;
    for (let i = 0; i < 4; i++) this.next();
  }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
  pick<T>(arr: readonly T[]): T {
    return arr[this.int(arr.length)];
  }
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}
