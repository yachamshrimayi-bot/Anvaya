import { Simulation } from '../src/engine/sim';
import { AnvayaAgent } from '../src/engine/anvaya';
import { DEFAULT_ALGO, DEFAULT_NET, SimConfig } from '../src/engine/types';
const [seed, n, layout, a, b, t0, t1] = process.argv.slice(2);
const cfg: SimConfig = { seed: +seed, layout: layout as any, width: 20, height: 20, robots: +n, planner: 'anvaya', orderRate: 0, initialOrders: +n*4, totalOrders: +n*4, urgentShare: 0.1, batteryEnabled: false, algo: { ...DEFAULT_ALGO }, net: { ...DEFAULT_NET, latency: Number(process.env.LAT ?? 1), packetLoss: Number(process.env.LOSS ?? 0.02) }, deadZones: [], crypto: false };
const s = new Simulation(cfg); const L = (c:number)=>c<0?'-':s.map.label(c);
while (s.t < +t1) { s.step(); if (s.t < +t0) continue;
  for (const id of [+a-1, +b-1]) { const ag = s.agents[id] as AnvayaAgent; const r = s.robots[id];
    console.log(`${s.t} R${id+1} ${L(r.prev)}->${L(r.pos)} goal ${L(ag.goal)} ${r.action} | plan ${r.plan.slice(0,7).map(L).join(' ')} | order ${ag.debug.order.map(x=>'R'+(x+1))} prec ${ag.debug.precedence.map(p=>`${p.winner+1}>${(p.winner===p.a?p.b:p.a)+1}:${p.basis}`).join(',')} | ${r.reason.slice(0,60)}`); } }
