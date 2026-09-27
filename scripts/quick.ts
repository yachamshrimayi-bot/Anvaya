import { Simulation } from '../src/engine/sim';
import { DEFAULT_ALGO, DEFAULT_NET, SimConfig } from '../src/engine/types';
const base: SimConfig = { seed: Number(process.argv[2] ?? 7), layout: (process.argv[4] as any) ?? 'fulfillment', width: 20, height: 20, robots: Number(process.argv[3] ?? 8), planner: 'anvaya',
  orderRate: 0, initialOrders: 30, totalOrders: 30, urgentShare: 0.1, batteryEnabled: false, algo: { ...DEFAULT_ALGO }, net: { ...DEFAULT_NET }, deadZones: [], crypto: false };
for (const planner of ['anvaya', 'baseline'] as const) {
  const s = new Simulation({ ...base, planner });
  const t0 = performance.now();
  while (!s.allDone() && s.t < 900) s.step();
  const m = s.m;
  console.log(planner.padEnd(9), `t=${s.t} done=${m.tasksDone}/${m.tasksCreated} coll=${m.collisions} estop=${m.estops} dead=${m.deadlocks} wait=${m.waitTicks} mean=${m.meanCompletion.toFixed(1)} rr=${m.reroutes} y=${m.yields} holds=${m.safetyHolds} clu=${m.avgCluster.toFixed(2)} agree=${(m.agreement*100).toFixed(0)}% think=${m.thinkMsAvg.toFixed(2)}ms wall=${(performance.now()-t0).toFixed(0)}ms`);
}
