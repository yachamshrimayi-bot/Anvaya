import { Simulation } from '../src/engine/sim';
import { makeScenario } from '../src/engine/scenarios';
const [id, rid, t0, t1] = process.argv.slice(2); const cfg = makeScenario(id, 7); const s = new Simulation(cfg); const L=(c:number)=>s.map.label(c);
while (s.t < +t1) { s.step(); if (s.t >= +t0 && s.t % 2 === 0) { const r = s.robots[+rid-1]; const a:any = s.agents[+rid-1]; console.log(`${s.t} ${L(r.prev)}->${L(r.pos)} ${a.mode} goal ${L(a.goal)} mv=${a.moveTicks} ${r.action} | ${r.plan.slice(0,6).map(L).join(' ')} | ${r.reason.slice(0,90)}`); } }
