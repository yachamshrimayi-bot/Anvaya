/**
 * ANVAYA engine — shared types.
 *
 * Coordinates are flattened cell indices (idx = y * width + x) everywhere in the
 * hot path. Time is measured in discrete control ticks.
 *
 * Physical scale: one grid cell = 1.2 m (a standard AMR travel lane), one tick = 1 s,
 * so a robot cruises at 1.2 m/s — typical for goods-to-person warehouse AMRs.
 */

export const CELL_METERS = 1.2;
export const TICK_SECONDS = 1;

export type Cell = number;

export enum CellKind {
  Floor = 0,
  Rack = 1,
  Drop = 2, // packing / outbound station
  Charger = 3,
  Home = 4, // parking / staging bay
}

export type Priority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';

export const PRIORITY_WEIGHT: Record<Priority, number> = {
  LOW: 1,
  NORMAL: 2,
  HIGH: 3,
  URGENT: 5,
};

/** Weight used for a robot with no mission (parked / returning home). */
export const IDLE_WEIGHT = 0.25;

export type PlannerKind = 'anvaya' | 'baseline';

export type RobotMode =
  | 'IDLE'
  | 'TO_PICKUP'
  | 'PICKING'
  | 'TO_DROP'
  | 'DROPPING'
  | 'TO_CHARGER'
  | 'CHARGING'
  | 'HOMING'
  | 'FAULT';

/** What a robot decided to do this tick — the "EXECUTE" verb shown in the UI. */
export type Action = 'GO' | 'WAIT' | 'YIELD' | 'REROUTE' | 'HOLD' | 'SERVICE' | 'STOPPED';

export type PeerHealth = 'HEALTHY' | 'STALE' | 'UNRESPONSIVE' | 'ISOLATED' | 'RECOVERING';

export interface AlgorithmParams {
  /** Rolling look-ahead window, ticks. 1 disables prediction. */
  horizon: number;
  /** Cost weights (see docs: fleet-wide cost function). */
  wDelay: number; // β
  wCongestion: number; // γ
  wReplan: number; // δ
  wFairness: number; // ε  (aging factor)
  wUncertainty: number; // ζ
  wEnergy: number; // η
  /** Minimum ticks a precedence decision / route is held before it may flip. */
  minCommit: number;
  /** A challenger decision must be better by this fraction to replace a committed one. */
  switchThreshold: number;
  /** Ticks without a heartbeat before a peer is STALE (then UNRESPONSIVE at 3x). */
  staleAfter: number;
  /** Trust below this => peer isolated (barred from bidding, treated as hazard). */
  isolationThreshold: number;
  /** Commitment lead K (ticks): a robot may only enter the cell its intent promised K ticks earlier. Set to the network latency bound. */
  commitLead: number;
  /** Ablation switches. */
  useFleetCost: boolean;
  useFairness: boolean;
  useTrust: boolean;
  useReservations: boolean;
}

export interface NetworkParams {
  /** One-way latency in ticks (0 = same tick). */
  latency: number;
  /** Independent per-delivery drop probability 0..1. */
  packetLoss: number;
  /** Radio range in cells (0 = unlimited, warehouse-wide mesh). */
  range: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type LayoutKind = 'fulfillment' | 'classic' | 'crossdock' | 'narrow' | 'custom';

export interface SimConfig {
  seed: number;
  layout: LayoutKind;
  width: number;
  height: number;
  robots: number;
  planner: PlannerKind;
  /** Orders per 100 ticks for the continuous (lifelong) order stream. 0 = only the initial batch. */
  orderRate: number;
  /** Initial batch of orders released at t=0. */
  initialOrders: number;
  /** Finite horizon of orders (0 = unlimited / lifelong). */
  totalOrders: number;
  urgentShare: number; // 0..1
  batteryEnabled: boolean;
  algo: AlgorithmParams;
  net: NetworkParams;
  deadZones: Rect[];
  /** Optional explicit rack cells (custom layouts / map editor). */
  customRacks?: Cell[];
  /** Optional explicit start cells. */
  starts?: Cell[];
  /** Optional scripted fault/event timeline. */
  timeline?: TimelineEvent[];
  /** Optional explicit orders (scenario presets). */
  orders?: OrderSpec[];
  /** Verify Ed25519 signatures on every message (true in the live twin). */
  crypto: boolean;
}

export interface OrderSpec {
  at: number;
  pickup: Cell;
  drop: Cell;
  priority: Priority;
}

export type FaultKind =
  | 'blackout' // radio off
  | 'slowdown' // motors degraded (moves every 2nd tick)
  | 'motor' // drive failure: cannot move, radio alive
  | 'rogue' // compromised: broadcasts forged position/plans (valid key)
  | 'heal'; // clear all faults on the robot

export type TimelineEvent =
  | { at: number; type: 'fault'; robot: number; fault: FaultKind; duration?: number }
  | { at: number; type: 'block'; cell: Cell; duration?: number }
  | { at: number; type: 'unblock'; cell: Cell }
  | { at: number; type: 'order'; pickup: Cell; drop: Cell; priority: Priority }
  | { at: number; type: 'spoof'; target: number } // attacker impersonates robot (bad signature)
  | { at: number; type: 'replay'; target: number } // attacker replays captured message
  | { at: number; type: 'caption'; text: string; focus?: Cell };

export interface Task {
  id: string;
  pickup: Cell;
  drop: Cell;
  priority: Priority;
  createdAt: number;
  assignedTo: number | null;
  pickedAt: number | null;
  doneAt: number | null;
  epoch: number;
}

export const DEFAULT_ALGO: AlgorithmParams = {
  horizon: 16,
  wDelay: 1.0,
  wCongestion: 0.6,
  wReplan: 0.8,
  wFairness: 0.08,
  wUncertainty: 2.0,
  wEnergy: 0.15,
  minCommit: 4,
  switchThreshold: 0.25,
  staleAfter: 3,
  isolationThreshold: 0.4,
  commitLead: 1,
  useFleetCost: true,
  useFairness: true,
  useTrust: true,
  useReservations: true,
};

export const DEFAULT_NET: NetworkParams = {
  latency: 1,
  packetLoss: 0.02,
  range: 0,
};
