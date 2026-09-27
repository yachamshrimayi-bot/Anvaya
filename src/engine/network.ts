import type { WarehouseMap } from './grid';
import type { Envelope } from './messages';
import { Rng } from './rng';
import type { Cell, NetworkParams, Rect } from './types';

export interface Pulse {
  from: number;
  to: number;
  fromCell: Cell;
  toCell: Cell;
  dropped: boolean;
  tag: Envelope['tag'];
}

interface InFlight {
  to: number;
  env: Envelope;
  at: number;
}

/**
 * Peer-to-peer broadcast medium (Wi-Fi mesh / DDS multicast model).
 * There is no broker: a datagram goes from the sender's radio to every radio in
 * range, each delivery independently subject to latency, loss and dead zones.
 */
export class MeshNetwork {
  params: NetworkParams;
  deadZones: Rect[];
  private map: WarehouseMap;
  private rng: Rng;
  private queue: InFlight[] = [];
  /** Radio power per node (false = blackout). */
  radioOff = new Set<number>();
  /** Visualisation: deliveries attempted this tick. */
  pulses: Pulse[] = [];
  stats = { sent: 0, delivered: 0, dropped: 0, deadZone: 0 };

  constructor(map: WarehouseMap, params: NetworkParams, deadZones: Rect[], seed: number) {
    this.map = map;
    this.params = { ...params };
    this.deadZones = deadZones.map((r) => ({ ...r }));
    this.rng = new Rng(seed ^ 0x5bd1e995);
  }

  inDeadZone(c: Cell): boolean {
    if (c < 0) return false;
    const x = this.map.x(c);
    const y = this.map.y(c);
    for (const r of this.deadZones) if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return true;
    return false;
  }

  /** Radio hardware link (false only on a blackout fault). */
  canTransmit(node: number, _at?: Cell): boolean {
    return !this.radioOff.has(node);
  }

  /** Wi-Fi fringe coverage: a dead zone drops this fraction of packets in or out. */
  static readonly DEAD_ZONE_LOSS = 0.9;

  /** Broadcast `env` to every receiver in `nodes` (id -> current cell). */
  broadcast(env: Envelope, sender: number, nodes: Map<number, Cell>, now: number): void {
    this.stats.sent++;
    if (sender >= 0 && !this.canTransmit(sender, env.origin)) {
      this.stats.deadZone++;
      return;
    }
    const range = this.params.range;
    const senderDark = env.origin >= 0 && this.inDeadZone(env.origin);
    for (const [id, cell] of nodes) {
      if (id === sender) continue;
      if (range > 0 && env.origin >= 0 && this.map.manhattan(env.origin, cell) > range) continue;
      const dark = senderDark || this.inDeadZone(cell);
      const lost = this.rng.chance(this.params.packetLoss) || (dark && this.rng.chance(MeshNetwork.DEAD_ZONE_LOSS));
      if (this.pulses.length < 400) {
        this.pulses.push({ from: sender, to: id, fromCell: env.origin, toCell: cell, dropped: lost, tag: env.tag });
      }
      if (lost) {
        if (dark) this.stats.deadZone++;
        else this.stats.dropped++;
        continue;
      }
      this.queue.push({ to: id, env, at: now + Math.max(0, this.params.latency | 0) });
    }
  }

  /** Deliver everything due by `now`. Receivers inside a dead zone / blackout miss it. */
  deliver(now: number, positions: Map<number, Cell>): Map<number, Envelope[]> {
    const out = new Map<number, Envelope[]>();
    const keep: InFlight[] = [];
    for (const f of this.queue) {
      if (f.at > now) {
        keep.push(f);
        continue;
      }
      const cell = positions.get(f.to);
      if (cell === undefined || !this.canTransmit(f.to, cell)) {
        this.stats.deadZone++;
        continue;
      }
      this.stats.delivered++;
      let box = out.get(f.to);
      if (!box) out.set(f.to, (box = []));
      box.push(f.env);
    }
    this.queue = keep;
    return out;
  }

  beginTick(): void {
    this.pulses = [];
  }
}
