import { Simulation } from '../src/engine/sim';
import { DEFAULT_ALGO, DEFAULT_NET, SimConfig } from '../src/engine/types';
const cfg: SimConfig = { seed: Number(process.argv[2] ?? 1), layout: 'fulfillment', width: 20, height: 20, robots: 8, planner: 'anvaya', orderRate: 0, initialOrders: 32, totalOrders: 32, urgentShare: 0.1, batteryEnabled: false, algo: { ...DEFAULT_ALGO }, net: { ...DEFAULT_NET }, deadZones: [], crypto: false };
const s = new Simulation(cfg); const cnt = new Map<string, number>();
while (!s.allDone() && s.t < 300) { s.step(); for (const r of s.robots) { const k = r.action + ' ' + r.reason.replace(/R\d+/g,'R#').replace(/\(\d+,\d+\)/g,'(x,y)').replace(/\d+/g,'N').slice(0,90); cnt.set(k, (cnt.get(k) ?? 0) + 1); } }
console.log('t', s.t, 'done', s.m.tasksDone); [...cnt].sort((a,b)=>b[1]-a[1]).slice(0,14).forEach(([k,v])=>console.log(v, k));
