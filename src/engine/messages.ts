import type { Cell, Priority, RobotMode } from './types';

export const WMS_ID = 999;

/**
 * Heartbeat = state + intent + liveness in one signed datagram (OBSERVE step).
 * Field order is fixed so the canonical JSON is byte-stable for signatures.
 */
export interface Heartbeat {
  k: 'HB';
  from: number;
  seq: number;
  t: number;
  pos: Cell;
  goal: Cell;
  mode: RobotMode;
  prio: Priority | null;
  task: string | null;
  epoch: number;
  bid: number; // bid for `task` when claimed (used for claim tie-breaks)
  wait: number; // accumulated waiting age (fairness)
  mv: number; // ticks per move (self-estimated speed)
  plan: Cell[]; // timed intent: plan[i] = intended cell at t + i
  bids: [string, number][];
  done: string[];
  rel: string[];
  blk: Cell[];
  clr: Cell[];
  chg: Cell;
  iso: number[]; // peers this robot currently isolates (for the safety supervisor)
  health: 'OK' | 'FAULT' | 'DEGRADED';
  batt: number;
  svc: number; // remaining ticks it is immovable (servicing / charging); -1 = indefinite
  prec: [number, number][]; // precedence decisions I hold for pairs involving me: [winner, loser]
}

export interface OrderMsg {
  k: 'ORDER';
  from: number;
  seq: number;
  t: number;
  id: string;
  pickup: Cell;
  drop: Cell;
  prio: Priority;
  at: number;
}

export type Payload = Heartbeat | OrderMsg;

export interface Envelope {
  /** Claimed sender (authenticated only by the signature). */
  from: number;
  text: string;
  sig: Uint8Array | null;
  sentAt: number;
  /** Sender position at send time (radio range / dead zones). */
  origin: Cell;
  /** Visual tag for the twin (not part of the signed payload). */
  tag?: 'hb' | 'order' | 'forged' | 'replay';
}

export function encode(p: Payload): string {
  return JSON.stringify(p);
}
