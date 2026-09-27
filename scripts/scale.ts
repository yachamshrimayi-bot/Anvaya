import { Simulation } from '../src/engine/sim';
import { baseConfig } from '../src/engine/scenarios';
for (const [n, W, layout] of [[32, 32, 'fulfillment'], [48, 40, 'fulfillment'], [64, 44, 'crossdock'], [96, 48, 'crossdock']] as const) {
  const cfg = baseConfig({ seed: 3, robots: n, width: W, height: W, layout, orderRate: 0, initialOrders: n * 2, totalOrders: n * 2, crypto: true, batteryEnabled: false });
  const s = new Simulation(cfg); const t0 = performance.now(); let worst = 0;
  while (!s.allDone() && s.t < 400) { const a = performance.now(); s.step(); worst = Math.max(worst, performance.now() - a); }
  console.log(`${n} robots ${W}x${W} ${layout}: t=${s.t} done=${s.m.tasksDone}/${s.m.tasksCreated} contacts=${s.m.collisions} estops=${s.m.estops} stalls=${s.m.deadlocks} scope=${s.m.avgCluster.toFixed(2)} avg ${( (performance.now()-t0)/s.t).toFixed(1)} ms/tick worst ${worst.toFixed(0)} ms`);
}
