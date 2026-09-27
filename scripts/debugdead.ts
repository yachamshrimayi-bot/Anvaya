import { Simulation } from '../src/engine/sim';
import { AnvayaAgent } from '../src/engine/anvaya';
import { DEFAULT_ALGO, DEFAULT_NET, SimConfig } from '../src/engine/types';
const seed = Number(process.argv[2] ?? 7), n = Number(process.argv[3] ?? 8);
const cfg: SimConfig = { seed, layout: (process.argv[4] as any) ?? 'fulfillment', width: 20, height: 20, robots: n, planner: 'anvaya', orderRate: 0, initialOrders: n*4, totalOrders: n*4, urgentShare: 0.1, batteryEnabled: false, algo: { ...DEFAULT_ALGO }, net: { ...DEFAULT_NET }, deadZones: [], crypto: false };
const s = new Simulation(cfg); const L = (c:number)=>s.map.label(c);
let prev = 0;
while (!s.allDone() && s.t < 400) {
  s.step();
  if (s.m.deadlocks > prev) { prev = s.m.deadlocks;
    const e = s.log.filter(l => l.text.includes('no progress')).slice(-1)[0]; console.log('t', s.t, e.text);
    for (let i = 0; i < s.robots.length; i++) { const a = s.agents[i] as AnvayaAgent; const d = s.lastDecisions[i];
      console.log(` R${i+1} ${a.mode} at ${L(s.robots[i].pos)} goal ${L(a.goal)} ${d.action} :: ${d.reason} | plan ${d.plan.slice(0,6).map(L).join(' ')} | order ${a.debug.order.map(x=>'R'+(x+1))} wait=${a.waitAge}`); }
  }
}
console.log(s.map.width, 'map:'); for (let y=0;y<s.map.height;y++){let row='';for(let x=0;x<s.map.width;x++){const c=s.map.idx(x,y);const r=s.robots.findIndex(q=>q.pos===c);row+= r>=0? String.fromCharCode(65+r) : s.map.kind[c]===1?'#':'.';}console.log(row);}
