/**
 * Prototype-preserving deep clone for time-travel snapshots.
 *
 * The simulation is a graph of plain class instances, Maps, Sets, arrays and typed
 * arrays (no closures in state), so a structural copy that keeps prototypes and
 * shared references reproduces it exactly. Immutable objects (the warehouse map,
 * key registry, identities) can be passed as `shared` and are referenced, not copied.
 */
export function cloneDeep<T>(root: T, shared: readonly object[] = []): T {
  const seen = new Map<unknown, unknown>();
  for (const s of shared) seen.set(s, s);
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    const hit = seen.get(v);
    if (hit !== undefined) return hit;
    if (ArrayBuffer.isView(v)) {
      const c = (v as unknown as { slice: () => unknown }).slice();
      seen.set(v, c);
      return c;
    }
    if (Array.isArray(v)) {
      const a: unknown[] = new Array(v.length);
      seen.set(v, a);
      for (let i = 0; i < v.length; i++) a[i] = walk(v[i]);
      return a;
    }
    if (v instanceof Map) {
      const m = new Map();
      seen.set(v, m);
      for (const [k, x] of v) m.set(walk(k), walk(x));
      return m;
    }
    if (v instanceof Set) {
      const st = new Set();
      seen.set(v, st);
      for (const x of v) st.add(walk(x));
      return st;
    }
    const o = Object.create(Object.getPrototypeOf(v)) as Record<string, unknown>;
    seen.set(v, o);
    for (const k of Object.keys(v as object)) o[k] = walk((v as Record<string, unknown>)[k]);
    return o;
  };
  return walk(root) as T;
}
