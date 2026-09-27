import { Simulation } from '../src/engine/sim';
import { DEFAULT_ALGO, DEFAULT_NET, LayoutKind, SimConfig } from '../src/engine/types';
const layouts = (process.argv[2] ?? 'fulfillment,classic,crossdock,narrow').split(',') as LayoutKind[];
const sizes = (process.argv[3] ?? '8,12').split(',').map(Number);
const loss = Number(process.argv[4] ?? 0.02), lat = Number(process.argv[5] ?? 1);
const seeds = Number(process.argv[6] ?? 12);
const planners = (process.argv[7] ?? 'anvaya,baseline').split(',') as any[];
for (const layout of layouts) for (const n of sizes) {
  const agg: Record<string, any> = {};
  for (const planner of planners) agg[planner] = { coll: 0, estop: 0, dead: 0, done: 0, tot: 0, mk: 0, wait: 0, fails: [] as number[] };
  for (let seed = 1; seed <= seeds; seed++) for (const planner of planners) {
    const W = n > 12 ? 24 : 20;
    const cfg: SimConfig = { seed, layout, width: W, height: W, robots: n, planner, orderRate: 0, initialOrders: n * 4, totalOrders: n * 4, urgentShare: 0.1, batteryEnabled: false, algo: { ...DEFAULT_ALGO }, net: { ...DEFAULT_NET, packetLoss: loss, latency: lat }, deadZones: [], crypto: false };
    const s = new Simulation(cfg);
    while (!s.allDone() && s.t < 700) s.step();
    const a = agg[planner];
    a.coll += s.m.collisions; a.estop += s.m.estops; a.dead += s.m.deadlocks; a.done += s.m.tasksDone; a.tot += s.m.tasksCreated; a.mk += s.t; a.wait += s.m.waitTicks;
    if (s.m.collisions || s.m.deadlocks || !s.allDone()) a.fails.push(seed);
  }
  for (const p of planners) { const a = agg[p]; console.log(`${layout.padEnd(11)} n=${String(n).padEnd(2)} ${p.padEnd(8)} coll=${a.coll} estop=${a.estop} dead=${a.dead} done=${a.done}/${a.tot} makespan=${(a.mk/seeds).toFixed(0)} wait=${(a.wait/seeds).toFixed(0)} fails=[${a.fails.join(',')}]`); }
}
