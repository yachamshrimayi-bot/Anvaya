import { Simulation } from '../src/engine/sim';
import { AnvayaAgent } from '../src/engine/anvaya';
import { DEFAULT_ALGO, DEFAULT_NET, SimConfig } from '../src/engine/types';
const seed = Number(process.argv[2] ?? 7), n = Number(process.argv[3] ?? 8);
const cfg: SimConfig = { seed, layout: 'fulfillment', width: 20, height: 20, robots: n, planner: 'anvaya', orderRate: 0, initialOrders: 30, totalOrders: 30, urgentShare: 0.1, batteryEnabled: false, algo: { ...DEFAULT_ALGO }, net: { ...DEFAULT_NET }, deadZones: [], crypto: false };
const s = new Simulation(cfg);
let prevC = 0; const L = (c:number)=>s.map.label(c);
const snap: string[] = [];
while (!s.allDone() && s.t < 400) {
  const before = s.robots.map(r => r.pos);
  s.step();
  if (s.m.collisions > prevC) {
    prevC = s.m.collisions;
    const e = s.log.filter(l => l.text.includes('COLLISION')).slice(-1)[0];
    console.log('t', s.t, e.text);
    for (let i = 0; i < s.robots.length; i++) {
      const a = s.agents[i] as AnvayaAgent; const d = s.lastDecisions[i];
      console.log(` R${i+1} at ${L(before[i])} next ${L(d.next)} ${d.action} :: ${d.reason} | plan ${d.plan.slice(0,5).map(L).join(' ')} | order ${a.debug.order.map(x=>'R'+(x+1))} deaf=${a.debug.deaf}`);
    }
  }
}
