import { buildMap } from './grid';
import { Rng } from './rng';
import type { LayoutKind, OrderSpec, Rect, SimConfig, TimelineEvent } from './types';
import { DEFAULT_ALGO, DEFAULT_NET } from './types';

/**
 * Scenario presets define only *initial conditions and injected events* — a map,
 * a fleet size, an order stream and a fault timeline. Nothing about how robots
 * react is scripted: every yield, re-route, isolation and re-auction you see is
 * computed live by the robots themselves.
 */
export interface ScenarioMeta {
  id: string;
  title: string;
  tagline: string;
  demonstrates: string[];
  watch: string;
  accent: string;
}

export const SCENARIOS: ScenarioMeta[] = [
  {
    id: 'rush',
    title: 'Rush hour',
    tagline: '12 AMRs, a continuous order stream and urgent orders.',
    demonstrates: ['Predict', 'Reserve', 'Fleet-wide cost', 'Fairness'],
    watch: 'Turn on the space-time view: every robot reserves its future path as a rising ribbon, and ribbons never intersect.',
    accent: 'lime',
  },
  {
    id: 'intersection',
    title: 'Intersection storm',
    tagline: 'Orders force robots across the same junctions at the same time.',
    demonstrates: ['Conflict graph', 'Precedence by fleet cost', 'Explainability'],
    watch: 'Open the decision log: each yield states the fleet cost of both orders of passage.',
    accent: 'mint',
  },
  {
    id: 'narrow',
    title: 'Single-lane aisles',
    tagline: 'Long one-lane aisles: the textbook deadlock trap for stop-and-wait.',
    demonstrates: ['Space-time A*', 'Commitment', 'Deadlock-free passage'],
    watch: 'Robots back out of an aisle early instead of meeting head-on. Compare with the baseline twin.',
    accent: 'silver',
  },
  {
    id: 'blackout',
    title: 'Wi-Fi dead zone + blackout',
    tagline: 'A radio dead zone, and one robot loses its radio mid-mission.',
    demonstrates: ['Heartbeat liveness', 'Unknown ≠ free', 'Safe degradation'],
    watch: 'The silent robot’s last intent turns into a red protected zone; peers route around it and the fleet keeps moving.',
    accent: 'coral',
  },
  {
    id: 'blocked',
    title: 'Blocked aisle',
    tagline: 'A pallet drops in the main cross-aisle. Nobody is told — robots find it.',
    demonstrates: ['Lidar discovery', 'P2P gossip', 'A* re-route', 'Task re-auction'],
    watch: 'The first robot to see the pallet gossips it; others re-route before they ever reach it.',
    accent: 'lime',
  },
  {
    id: 'rogue',
    title: 'Compromised robot',
    tagline: 'R5’s firmware starts lying; an attacker also forges and replays messages.',
    demonstrates: ['Ed25519 signatures', 'Behavioural trust', 'Isolation', 'Quarantine'],
    watch: 'Trust in R5 falls below 0.40 within seconds; peers isolate it, re-auction its task, and its own safety PLC stops it.',
    accent: 'coral',
  },
  {
    id: 'degraded',
    title: 'Degraded hardware',
    tagline: 'R4’s motors silently drop to half speed; later R6’s drive fails.',
    demonstrates: ['Plan vs reality', 'Self-diagnosis', 'Adaptive safety margin', 'Re-assignment'],
    watch: 'Peers notice R4 lagging its own intent, trust dips, margins grow — then R4 re-plans at half speed itself.',
    accent: 'mint',
  },
  {
    id: 'parallel',
    title: 'Independent aisles',
    tagline: 'Robots with non-overlapping work.',
    demonstrates: ['Coordinate only when needed', 'Zero interference'],
    watch: 'Coordination scope stays at 1: global coordination never becomes global interference.',
    accent: 'silver',
  },
  {
    id: 'scale',
    title: 'Scale test · 48 AMRs',
    tagline: '48 robots on a 48 m warehouse floor with a heavy order stream.',
    demonstrates: ['Scales by interaction', 'Local clusters', 'Zero collisions'],
    watch: 'Coordination scope stays around 5: each robot only ever negotiates with the few robots it will actually meet — that is why it scales.',
    accent: 'mint',
  },
  {
    id: 'random',
    title: 'Surprise me',
    tagline: 'A random seed picks the layout, fleet, orders and faults.',
    demonstrates: ['Nothing is hard-coded'],
    watch: 'Press it again — a different warehouse, a different day, the same guarantees.',
    accent: 'lime',
  },
];

export function baseConfig(partial: Partial<SimConfig> = {}): SimConfig {
  return {
    seed: 7,
    layout: 'fulfillment',
    width: 20,
    height: 20,
    robots: 10,
    planner: 'anvaya',
    orderRate: 5,
    initialOrders: 14,
    totalOrders: 0,
    urgentShare: 0.12,
    batteryEnabled: true,
    algo: { ...DEFAULT_ALGO },
    net: { ...DEFAULT_NET },
    deadZones: [],
    crypto: true,
    ...partial,
  };
}

export function makeScenario(id: string, seed?: number): SimConfig {
  const s = seed ?? 7;
  switch (id) {
    case 'rush':
      return baseConfig({ seed: s, robots: 12, width: 22, height: 22, orderRate: 7, initialOrders: 18, urgentShare: 0.18 });
    case 'intersection': {
      const cfg = baseConfig({ seed: s, layout: 'crossdock', robots: 10, width: 20, height: 20, orderRate: 0, initialOrders: 0 });
      const map = buildMap(cfg.layout, cfg.width, cfg.height);
      const rng = new Rng(s);
      const orders: OrderSpec[] = [];
      // Orders that pair opposite sides of the floor so paths cross the centre.
      const west = map.pickFaces.filter((c) => map.x(c) < 7);
      const east = map.pickFaces.filter((c) => map.x(c) > map.width - 8);
      const north = map.pickFaces.filter((c) => map.y(c) < 7);
      const south = map.pickFaces.filter((c) => map.y(c) > map.height - 8);
      for (let i = 0; i < 26; i++) {
        const pair = i % 2 === 0 ? [west, east] : [north, south];
        const [a, b] = rng.chance(0.5) ? pair : [pair[1], pair[0]];
        orders.push({ at: Math.floor(i / 5) * 12, pickup: rng.pick(a), drop: rng.pick(map.drops), priority: i % 7 === 0 ? 'URGENT' : 'NORMAL' });
        void b;
      }
      cfg.orders = orders;
      cfg.totalOrders = orders.length;
      return cfg;
    }
    case 'narrow':
      return baseConfig({ seed: s, layout: 'narrow', robots: 8, orderRate: 4, initialOrders: 12 });
    case 'blackout': {
      const cfg = baseConfig({ seed: s, robots: 10, orderRate: 5, initialOrders: 14 });
      const dz: Rect = { x: 12, y: 7, w: 4, h: 5 };
      cfg.deadZones = [dz];
      cfg.timeline = [
        { at: 2, type: 'caption', text: 'A Wi-Fi dead zone (hatched) swallows every packet sent or received inside it.' },
        { at: 30, type: 'fault', robot: 2, fault: 'blackout', duration: 45 },
        { at: 31, type: 'caption', text: 'R3’s radio just died. Watch its last intent turn into a protected zone — unknown ≠ free.' },
        { at: 78, type: 'caption', text: 'R3 is back: peers re-verify its position and trust climbs gradually.' },
      ];
      return cfg;
    }
    case 'blocked': {
      const cfg = baseConfig({ seed: s, robots: 10, orderRate: 5, initialOrders: 14 });
      const map = buildMap(cfg.layout, cfg.width, cfg.height);
      const midY = Math.floor(map.height / 2) - 1;
      const cells = [8, 9].map((x) => map.idx(x, midY)).concat([map.idx(9, midY + 1), map.idx(8, midY + 1)]);
      const tl: TimelineEvent[] = [{ at: 20, type: 'caption', text: 'A pallet is about to drop in the main cross-aisle. No one will tell the robots.' }];
      for (const c of cells) if (map.walkable(c)) tl.push({ at: 24, type: 'block', cell: c, duration: 140 });
      tl.push({ at: 26, type: 'caption', text: 'Blocked. The first robot whose lidar sees it will gossip it over the mesh.' });
      cfg.timeline = tl;
      return cfg;
    }
    case 'rogue': {
      const cfg = baseConfig({ seed: s, robots: 10, orderRate: 5, initialOrders: 14 });
      cfg.timeline = [
        { at: 25, type: 'fault', robot: 4, fault: 'rogue' },
        { at: 26, type: 'caption', text: 'R5’s firmware is compromised: it still signs with its real key, but lies about where it is and what it will do.' },
        { at: 55, type: 'spoof', target: 1 },
        { at: 56, type: 'caption', text: 'An outside attacker impersonates R2 — without R2’s private key the Ed25519 signature fails.' },
        { at: 80, type: 'replay', target: 3 },
        { at: 81, type: 'caption', text: 'Replay attack: a genuinely signed old message from R4 is re-broadcast. Sequence numbers reject it.' },
      ];
      return cfg;
    }
    case 'degraded': {
      const cfg = baseConfig({ seed: s, robots: 10, orderRate: 5, initialOrders: 14 });
      cfg.timeline = [
        { at: 20, type: 'fault', robot: 3, fault: 'slowdown' },
        { at: 21, type: 'caption', text: 'R4’s motors silently drop to half speed. Nobody reports it — the fleet must notice.' },
        { at: 70, type: 'fault', robot: 5, fault: 'motor', duration: 80 },
        { at: 71, type: 'caption', text: 'R6’s drive fails outright. Its task is re-auctioned and peers treat it as a static obstacle.' },
      ];
      return cfg;
    }
    case 'parallel': {
      const cfg = baseConfig({ seed: s, layout: 'classic', robots: 4, orderRate: 0, initialOrders: 0, batteryEnabled: false });
      const map = buildMap(cfg.layout, cfg.width, cfg.height);
      const rows = [5, 9, 13, 17].filter((y) => y < map.height - 1);
      cfg.starts = rows.map((y) => map.idx(1, y));
      const orders: OrderSpec[] = [];
      rows.forEach((y, i) => {
        for (let k = 0; k < 3; k++) orders.push({ at: k * 30 + i, pickup: map.idx(map.width - 2, y), drop: map.idx(1, y), priority: 'NORMAL' });
      });
      cfg.orders = orders.filter((o) => map.walkable(o.pickup) && map.walkable(o.drop));
      cfg.totalOrders = cfg.orders.length;
      return cfg;
    }
    case 'scale':
      return baseConfig({ seed: s, robots: 48, width: 40, height: 40, orderRate: 16, initialOrders: 60, urgentShare: 0.12, batteryEnabled: false });
    case 'random': {
      const r = new Rng(s * 131 + 7);
      const layouts: LayoutKind[] = ['fulfillment', 'classic', 'crossdock', 'narrow'];
      const layout = r.pick(layouts);
      const size = 18 + r.int(7);
      const robots = 6 + r.int(8);
      const cfg = baseConfig({ seed: s, layout, width: size, height: size, robots, orderRate: 3 + r.int(6), initialOrders: robots + r.int(10), urgentShare: r.next() * 0.25 });
      const tl: TimelineEvent[] = [];
      const faults = ['blackout', 'slowdown', 'motor', 'rogue'] as const;
      const nf = 1 + r.int(3);
      for (let i = 0; i < nf; i++) {
        const f = r.pick(faults);
        tl.push({ at: 20 + r.int(80), type: 'fault', robot: r.int(robots), fault: f, duration: f === 'rogue' ? undefined : 40 + r.int(60) });
      }
      if (r.chance(0.6)) cfg.deadZones = [{ x: 3 + r.int(size - 8), y: 3 + r.int(size - 8), w: 3 + r.int(3), h: 3 + r.int(3) }];
      tl.push({ at: 2, type: 'caption', text: `Random warehouse: ${layout}, ${size}×${size}, ${robots} AMRs, ${nf} injected fault${nf > 1 ? 's' : ''}. Seed ${s}.` });
      cfg.timeline = tl;
      return cfg;
    }
    default:
      return baseConfig({ seed: s });
  }
}
