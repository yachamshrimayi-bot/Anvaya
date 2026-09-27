import { Simulation } from '../src/engine/sim';
import { SCENARIOS, makeScenario } from '../src/engine/scenarios';
import { cryptoStats } from '../src/engine/crypto';
for (const sc of SCENARIOS) for (const planner of ['anvaya', 'baseline'] as const) {
  const cfg = makeScenario(sc.id, Number(process.argv[2] ?? 7)); cfg.planner = planner;
  const s = new Simulation(cfg); const t0 = performance.now();
  const T = cfg.totalOrders > 0 ? 400 : 250;
  while (s.t < T && !(cfg.totalOrders > 0 && s.allDone())) s.step();
  const m = s.m; const kinds: Record<string, number> = {};
  for (const l of s.log) kinds[l.kind] = (kinds[l.kind] ?? 0) + 1;
  console.log(`${sc.id.padEnd(12)} ${planner.padEnd(8)} t=${s.t} done=${m.tasksDone}/${m.tasksCreated} contact=${m.collisions} estop=${m.estops} dead=${m.deadlocks} wait=${m.waitTicks} sec=${m.securityRejects} iso=${m.isolations} agree=${(m.agreement*100).toFixed(0)}% scope=${m.avgCluster.toFixed(2)} ms/robot=${m.thinkMsAvg.toFixed(2)} wall=${(performance.now()-t0).toFixed(0)}ms`);
  if (planner === 'anvaya' && ['rogue','blackout','degraded','blocked'].includes(sc.id)) for (const l of s.log.filter(l => ['security','trust','fault','safety','task'].includes(l.kind) && !l.text.includes('wins') && !l.text.includes('delivered')).slice(0, 9)) console.log(`     t${l.t} [${l.kind}] ${l.text}${l.count>1?` (×${l.count})`:''}`);
}
console.log(cryptoStats);
