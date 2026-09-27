import { Simulation } from '../src/engine/sim';
import { DEFAULT_ALGO, DEFAULT_NET, SimConfig } from '../src/engine/types';
const seed = Number(process.argv[2]), n = Number(process.argv[3]);
const cfg: SimConfig = { seed, layout: process.argv[4] as any, width: n>12?24:20, height: n>12?24:20, robots: n, planner: 'anvaya', orderRate: 0, initialOrders: n*4, totalOrders: n*4, urgentShare: 0.1, batteryEnabled: false, algo: { ...DEFAULT_ALGO }, net: { ...DEFAULT_NET, latency: Number(process.env.LAT ?? 1), packetLoss: Number(process.env.LOSS ?? 0.02) }, deadZones: [], crypto: false };
const s = new Simulation(cfg); const L = (c:number)=>s.map.label(c);
const hist: string[][] = s.robots.map(() => []); let prev = 0;
while (!s.allDone() && s.t < 500) { s.step();
  s.robots.forEach((r, i) => { hist[i].push(`${s.t}:${L(r.pos)} ${r.action} ${r.reason.slice(0, 70)}`); if (hist[i].length > 34) hist[i].shift(); });
  if (s.m.deadlocks > prev) { prev = s.m.deadlocks; const i = s.robots.findIndex(r => r.deadlocked && r.progressT === s.t - 31) ; const k = i >= 0 ? i : s.robots.findIndex(r=>r.deadlocked);
    console.log(`== R${k+1} goal ${L((s.agents[k] as any).goal)} mode ${s.agents[k].mode}`); console.log(hist[k].filter((_, j) => j % 3 === 0).join('\n')); break; } }
