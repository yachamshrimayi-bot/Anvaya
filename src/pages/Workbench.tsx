import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AnvayaAgent } from '../engine/anvaya';
import { familyConfig, VARIANTS } from '../engine/benchmark';
import { SCENARIOS } from '../engine/scenarios';
import type { FaultKind, LayoutKind } from '../engine/types';
import { controller, ROBOT_COLORS, type Tool } from '../sim/controller';
import { ACTION_COLOR, CamMode, Twin } from '../three/Twin';
import { DocsModal } from '../ui/Docs';
import { Help, HoverSelect, Icon, Kpi, Section, Seg, Slider, Sparkline, Toggle } from '../ui/kit';
import { Nav } from '../ui/Nav';
import { Minimap } from '../ui/Minimap';
import { Timeline } from '../ui/Timeline';
import { Tour, TourStep } from '../ui/Tour';

const useTick = () => useSyncExternalStore((cb) => controller.subscribe(cb), () => controller.version);

const LOG_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'decision', label: 'Decisions', kinds: ['yield', 'reroute', 'decision'] },
  { id: 'safety', label: 'Safety', kinds: ['safety', 'fault'] },
  { id: 'security', label: 'Security', kinds: ['security', 'trust'] },
  { id: 'task', label: 'Auction', kinds: ['task'] },
];
const KIND_COLOR: Record<string, string> = {
  yield: '#fbbf24', reroute: '#67e8f9', decision: '#c9f46b', safety: '#fb923c', fault: '#f87171', security: '#e879f9', trust: '#a78bfa', task: '#5eead4', info: '#9ca3af',
};

const TOUR: TourStep[] = [
  { target: 'scenarios', title: 'Pick a situation', body: 'Each scenario only sets the starting conditions and injected events. Every reaction you will see is decided live by the robots.' },
  { target: 'play', title: 'Run the fleet', body: 'Play, pause or step one second at a time (Space / → keys). Change speed any time — the engine keeps running the real algorithm at every tick.' },
  { target: 'canvas', title: 'The digital twin', body: 'Drag to orbit, scroll to zoom, click any robot to inspect it. Light ring colour = what it decided: lime go, amber yield, orange hold, cyan re-route, teal servicing, red stopped.' },
  { target: 'view', title: 'See the future', body: 'Turn on “Space-time ribbons”: every robot’s reserved future path rises as a ribbon, one layer per second. Ribbons never occupy the same square at the same height — that is the reservation table.' },
  { target: 'algo', title: 'Tune the brain', body: 'Every weight of the fleet-cost function is live. Hover the “?” next to any parameter to see exactly what it does. Switch components off to run your own ablation study.' },
  { target: 'faults', title: 'Break something', body: 'Kill a radio, slow a motor, compromise a robot’s firmware, forge or replay messages. Watch trust fall, isolation kick in and tasks get re-auctioned — without stopping the fleet.' },
  { target: 'tools', title: 'Change the world', body: 'Use the tools to drop a pallet into an aisle, paint a Wi-Fi dead zone, or place an urgent order (click pickup, then drop-off).' },
  { target: 'compare', title: 'Prove it', body: 'Compare mode runs the identical day with a stop-and-wait baseline side by side, from t = 0, so you can see the difference, not just read about it.' },
  { target: 'log', title: 'Read the why', body: 'Every decision is explained: who yielded to whom, the fleet cost of both orders of passage, trust changes, re-auctions and safety events.' },
];

export default function Workbench() {
  useTick();
  const [params] = useSearchParams();
  const [cam, setCamState] = useState<CamMode>('iso');
  const [camNonce, setCamNonce] = useState(0);
  // Choosing a view — even the current one — always snaps the camera back to that view's default framing.
  const setCam = (m: CamMode) => {
    setCamState(m);
    setCamNonce((n) => n + 1);
  };
  const [docs, setDocs] = useState(false);
  const [tour, setTour] = useState(false);
  const [tutorialOpen, setTutorialOpen] = useState(() => {
    try {
      return localStorage.getItem('anvaya.tutorial') !== 'closed';
    } catch {
      return true;
    }
  });
  const [logFilter, setLogFilter] = useState('all');
  const [faultRobot, setFaultRobot] = useState(0);
  const sim = controller.sim;
  const cfg = controller.cfg;

  // Deep links from the benchmark: /workbench?family=dense&seed=3&variant=anvaya
  useEffect(() => {
    const f = params.get('family');
    if (f) {
      const c = familyConfig(f, Number(params.get('seed') ?? 1));
      const v = VARIANTS.find((x) => x.id === params.get('variant'));
      if (v) {
        c.planner = v.kind;
        Object.assign(c.algo, v.patch ?? {});
      }
      c.crypto = true;
      controller.load(c, `bench:${f}`);
    }
    controller.start();
    controller.playing = false;
    controller.notify();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.code === 'Space') {
        e.preventDefault();
        controller.playing = !controller.playing;
        controller.notify();
      } else if (e.key === 'ArrowRight') {
        if (controller.live) controller.stepOnce();
        else controller.seek(controller.sim.t + 1);
      } else if (e.key === 'ArrowLeft') controller.seek(controller.sim.t - (e.shiftKey ? 10 : 1));
      else if (e.key === 'r' || e.key === 'R') controller.reset();
      else if (e.key === 'Escape') {
        controller.selected = -1;
        controller.beliefOf = -1;
        controller.notify();
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  const scenario = SCENARIOS.find((s) => s.id === controller.scenarioId);
  const lastCaption = [...controller.captions].reverse().find((c) => sim.t - c.t < 30);
  const setTool = (t: Tool) => {
    controller.tool = t;
    controller.orderDraft.pickup = null;
    controller.notify();
  };
  const fault = (f: FaultKind, d?: number) => controller.fault(faultRobot, f, d);
  const sel = controller.selected;
  const selAgent = sel >= 0 ? controller.agent(sel) : null;
  const selTruth = sel >= 0 ? sim.robots[sel] : null;
  const closeTutorial = () => {
    setTutorialOpen(false);
    try {
      localStorage.setItem('anvaya.tutorial', 'closed');
    } catch {
      /* private mode */
    }
  };

  return (
    <div className="page wb">
      <div className="frame">
        <div className="inner">
          <Nav
            right={
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn" onClick={() => setTour(true)}>
                  Guided tour
                </button>
                <button className="btn" onClick={() => setDocs(true)}>
                  Read docs →
                </button>
              </div>
            }
          />

          {/* ------------------------------------------------------ tutorial strip */}
          {tutorialOpen ? (
            <div className="tutorial">
              <div className="tut-head">
                <div>
                  <div className="eyebrow">How to use the workbench</div>
                  <div className="h3" style={{ marginTop: 4 }}>
                    Four moves, sixty seconds.
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn lime" onClick={() => setTour(true)}>
                    {Icon.play} Start guided tour
                  </button>
                  <button className="btn ghost" onClick={closeTutorial}>
                    Hide
                  </button>
                </div>
              </div>
              <div className="tut-steps">
                {[
                  { n: '01', t: 'Pick a scenario', d: 'Left panel → 01. Rush hour, blackout, rogue robot, blocked aisle… or “Surprise me”.', c: 'coral' },
                  { n: '02', t: 'Press play & look ahead', d: 'Space to play. Turn on “Space-time ribbons” to see every robot’s reserved future.', c: 'mint' },
                  { n: '03', t: 'Break something', d: 'Kill a radio, compromise a robot, drop a pallet, add packet loss. The fleet adapts live.', c: 'silver' },
                  { n: '04', t: 'Ask “why?”', d: 'Click any robot: its decision, the fleet-cost numbers behind it, and whom it trusts.', c: 'lime' },
                ].map((s) => (
                  <div key={s.n} className={`pastel ${s.c} tut-card`}>
                    <div className="mono" style={{ fontSize: 12, opacity: 0.6 }}>
                      {s.n}
                    </div>
                    <h4 style={{ fontSize: 18, marginTop: 4 }}>{s.t}</h4>
                    <p>{s.d}</p>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="tut-collapsed">
              <span className="muted">New here?</span>
              <button className="btn sm" onClick={() => setTutorialOpen(true)}>
                Show tutorial
              </button>
              <button className="btn sm lime" onClick={() => setTour(true)}>
                Guided tour
              </button>
            </div>
          )}

          <div className="wb-grid">
            {/* ================================================== LEFT: controls */}
            <aside className="wb-left scroll-y">
              <Section n="01" title="Scenario" tourId="scenarios">
                <div className="scen-grid">
                  {SCENARIOS.map((s) => (
                    <button key={s.id} className={`scen acc-${s.accent} ${controller.scenarioId === s.id ? 'on' : ''}`} onClick={() => controller.loadScenario(s.id)}>
                      <b>{s.title}</b>
                      <span>{s.tagline}</span>
                    </button>
                  ))}
                </div>
                {scenario && (
                  <div className="watch">
                    <div className="eyebrow" style={{ fontSize: 10.5 }}>
                      What to watch
                    </div>
                    {scenario.watch}
                    <div className="chips">
                      {scenario.demonstrates.map((d) => (
                        <span key={d} className="pill">
                          {d}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                <div className="ctl" style={{ marginTop: 12 }}>
                  <div className="ctl-head">
                    Seed
                    <Help title="Seed">Every run is reproducible from its seed: map, orders, starting positions and radio losses. Change it to get a different day in the same warehouse.</Help>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input type="number" value={cfg.seed} onChange={(e) => controller.patchWorld({ seed: Number(e.target.value) || 1 })} />
                    <button className="btn sm" onClick={() => controller.patchWorld({ seed: Math.floor(Math.random() * 99999) })}>
                      New day
                    </button>
                  </div>
                </div>
              </Section>

              <Section n="02" title="Fleet & warehouse">
                <div className="ctl">
                  <div className="ctl-head">
                    Layout
                    <Help title="Warehouse layout">Fulfilment: double-deep racks with single-lane pick aisles. Classic: wide aisles. Cross-dock: open floor with pillars (many intersections). Narrow: long single-lane aisles — the hardest case for head-on conflicts.</Help>
                  </div>
                  <Seg<LayoutKind>
                    value={cfg.layout}
                    options={[
                      { v: 'fulfillment', label: 'Fulfilment' },
                      { v: 'classic', label: 'Classic' },
                      { v: 'crossdock', label: 'Cross-dock' },
                      { v: 'narrow', label: 'Narrow' },
                    ]}
                    onChange={(v) => controller.patchWorld({ layout: v, customRacks: undefined, starts: undefined, orders: undefined, totalOrders: 0, timeline: [] })}
                  />
                </div>
                <Slider label="Robots" value={cfg.robots} min={2} max={64} onChange={(v) => controller.patchWorld({ robots: v, starts: undefined, width: Math.max(cfg.width, v > 40 ? 40 : v > 24 ? 32 : v > 14 ? 24 : cfg.width), height: Math.max(cfg.height, v > 40 ? 40 : v > 24 ? 32 : v > 14 ? 24 : cfg.height) })} help={<>Number of AMRs (up to 64). Every one runs its own copy of ANVAYA and talks only peer-to-peer. The floor grows automatically so the fleet fits. Cost grows with the size of each robot's interaction cluster, not with the fleet — watch "coordination scope".</>} />
                <Slider label="Floor size" value={cfg.width} min={14} max={48} format={(v) => `${v}×${v} (${(v * 1.2).toFixed(0)} m)`} onChange={(v) => controller.patchWorld({ width: v, height: v, starts: undefined, orders: undefined, totalOrders: 0, timeline: [] })} help={<>Grid squares per side. One square = 1.2 m, a standard AMR lane.</>} />
                <Toggle label="Battery & charging" on={cfg.batteryEnabled} onChange={(v) => controller.patchWorld({ batteryEnabled: v })} help={<>Robots drain battery while driving, stop bidding below 25%, and claim a charger (a shared resource announced over the mesh) below 22%.</>} />
              </Section>

              <Section n="03" title="Orders" defaultOpen={false}>
                <Slider label="Order rate" value={cfg.orderRate} min={0} max={15} format={(v) => `${v} / 100 s`} onChange={(v) => controller.patchWorld({ orderRate: v })} help={<>How many new orders the warehouse system releases per 100 seconds (seeded random stream). The WMS only announces orders — robots decide who takes them in a P2P auction.</>} />
                <Slider label="Urgent share" value={Math.round(cfg.urgentShare * 100)} min={0} max={50} format={(v) => `${v}%`} onChange={(v) => controller.patchWorld({ urgentShare: v / 100 })} help={<>Fraction of URGENT orders (weight 5 vs NORMAL 2). Urgent robots win more precedence decisions — but aging keeps others from starving.</>} />
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button className="btn sm" onClick={() => controller.releaseOrders(5)}>
                    Release 5 orders
                  </button>
                  <button className={`btn sm ${controller.tool === 'order' ? 'lime' : ''}`} onClick={() => setTool('order')}>
                    Place urgent order
                  </button>
                </div>
              </Section>

              <Section n="04" title="Coordination algorithm" tourId="algo">
                <div className="subhead">Look-ahead & stability</div>
                <Slider label="Prediction horizon H" value={cfg.algo.horizon} min={3} max={24} format={(v) => `${v} s`} onChange={(v) => controller.patchAlgo({ horizon: v })} help={<>How far into the future every robot predicts and reserves space-time. At 3 s robots see conflicts too late and gridlock (see the benchmark ablation). <b>Applies to new plans immediately.</b></>} />
                <Slider label="Min commit (ticks)" value={cfg.algo.minCommit} min={1} max={12} onChange={(v) => controller.patchAlgo({ minCommit: v })} help={<>A precedence decision is never flipped within this many ticks; afterwards only if the winner stops making progress. Prevents robots “dancing” in an aisle.</>} />
                <div className="subhead">Fleet-cost weights</div>
                <Slider label="β  delay" value={cfg.algo.wDelay} min={0.5} max={3} step={0.1} onChange={(v) => controller.patchAlgo({ wDelay: v })} help={<>Cost of one second of delay. Multiplied by the mission weight (LOW 1 · NORMAL 2 · HIGH 3 · URGENT 5) in precedence decisions.</>} />
                <Slider label="γ  congestion" value={cfg.algo.wCongestion} min={0} max={2} step={0.05} onChange={(v) => controller.patchAlgo({ wCongestion: v })} help={<>Penalty for squares many robots are about to cross, and for blocking robots queued behind you. Higher = traffic spreads over parallel aisles earlier.</>} />
                <Slider label="δ  route change" value={cfg.algo.wReplan} min={0} max={3} step={0.1} onChange={(v) => controller.patchAlgo({ wReplan: v })} help={<>Penalty for leaving the route a robot already announced. Higher = more stable routes, fewer re-routes (hysteresis).</>} />
                <Slider label="ε  fairness / aging" value={cfg.algo.wFairness} min={0} max={0.4} step={0.01} onChange={(v) => controller.patchAlgo({ wFairness: v })} help={<>Each second of waiting adds ε to a robot’s effective priority and multiplies its delay cost by (1+ε·age). Guarantees nobody waits forever.</>} />
                <Slider label="ζ  uncertainty" value={cfg.algo.wUncertainty} min={0} max={5} step={0.1} onChange={(v) => controller.patchAlgo({ wUncertainty: v })} help={<>Penalty for driving close to silent, untrusted or unknown robots. Higher = wider berth around uncertainty.</>} />
                <Slider label="η  energy" value={cfg.algo.wEnergy} min={0} max={0.6} step={0.01} onChange={(v) => controller.patchAlgo({ wEnergy: v })} help={<>Cost per move (a wait costs 0.2η). Breaks ties toward routes with fewer moves.</>} />
                <div className="subhead">Trust & liveness</div>
                <Slider label="Isolation threshold θ" value={cfg.algo.isolationThreshold} min={0.1} max={0.8} step={0.05} onChange={(v) => controller.patchAlgo({ isolationThreshold: v })} help={<>A robot whose trust (as judged by a peer) drops below θ is isolated by that peer: its claims are ignored, it may not bid, and its surroundings are reserved.</>} />
                <Slider label="Stale after" value={cfg.algo.staleAfter} min={1} max={10} format={(v) => `${v} s`} onChange={(v) => controller.patchAlgo({ staleAfter: v })} help={<>Seconds without a heartbeat before a peer is STALE (and its last intent is protected). 3× this = UNRESPONSIVE (its task is re-auctioned).</>} />
                <div className="subhead">Ablation switches</div>
                <Toggle label="Fleet-wide cost" on={cfg.algo.useFleetCost} onChange={(v) => controller.patchAlgo({ useFleetCost: v })} help={<>Off = precedence by effective priority only (no re-planning of both options).</>} />
                <Toggle label="Fairness (aging)" on={cfg.algo.useFairness} onChange={(v) => controller.patchAlgo({ useFairness: v })} help={<>Off = waiting time never raises priority; station queues are not FIFO.</>} />
                <Toggle label="Trust & adaptive margins" on={cfg.algo.useTrust} onChange={(v) => controller.patchAlgo({ useTrust: v })} help={<>Off = every message is believed and margins are zero (signatures are still checked).</>} />
                <Toggle label="Predictive reservations" on={cfg.algo.useReservations} onChange={(v) => controller.patchAlgo({ useReservations: v })} help={<>Off = robots only consider each other’s very next step.</>} />
                <div className="ctl" style={{ marginTop: 8 }}>
                  <div className="ctl-head">
                    Planner
                    <Help title="Planner">Switch the whole fleet to the stop-and-wait baseline (independent shortest paths, react only to the next cell) — or use Compare mode to run both at once.</Help>
                  </div>
                  <Seg value={cfg.planner} options={[{ v: 'anvaya', label: 'ANVAYA' }, { v: 'baseline', label: 'Stop-and-wait' }]} onChange={(v) => controller.patchWorld({ planner: v })} />
                </div>
              </Section>

              <Section n="05" title="Network">
                <Slider label="Latency" value={cfg.net.latency} min={0} max={3} format={(v) => `${v} s`} onChange={(v) => controller.patchNet({ latency: v })} help={<>One-way radio delay. Robots automatically commit K = max(1, latency) seconds ahead so their promises reach peers in time — that is what keeps the right-of-way proof valid. More latency = more cautious fleet.</>} />
                <Slider label="Packet loss" value={Math.round(cfg.net.packetLoss * 100)} min={0} max={40} format={(v) => `${v}%`} onChange={(v) => controller.patchNet({ packetLoss: v / 100 })} help={<>Probability each delivery is lost. Missing a peer’s latest promise makes a robot treat that peer as unknown (unknown ≠ free) at contested cells.</>} />
                <Toggle label="Verify Ed25519 on every message" on={cfg.crypto} onChange={(v) => controller.patchWorld({ crypto: v })} help={<>Every heartbeat is signed with the robot’s private key and verified by each receiver with its enrolled public key (RFC 8032, @noble/ed25519). Forged and replayed messages are rejected.</>} />
                <button className={`btn sm ${controller.tool === 'deadzone' ? 'lime' : ''}`} onClick={() => setTool('deadzone')}>
                  Paint Wi-Fi dead zone
                </button>
              </Section>

              <Section n="06" title="Faults & attacks" tourId="faults">
                <div className="ctl">
                  <div className="ctl-head">
                    Target robot
                    <Help title="Target robot">Robot to break. Tip: click a robot in the 3D view first, then pick it here.</Help>
                  </div>
                  <select value={faultRobot} onChange={(e) => setFaultRobot(Number(e.target.value))}>
                    {sim.robots.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="fault-grid">
                  <button className="btn sm danger" onClick={() => fault('blackout', 40)}>Radio blackout 40 s</button>
                  <button className="btn sm danger" onClick={() => fault('slowdown')}>Degrade motors</button>
                  <button className="btn sm danger" onClick={() => fault('motor', 60)}>Drive failure 60 s</button>
                  <button className="btn sm danger" onClick={() => fault('rogue')}>Compromise firmware</button>
                  <button className="btn sm danger" onClick={() => controller.spoof(faultRobot)}>Forge its identity</button>
                  <button className="btn sm danger" onClick={() => controller.replay(faultRobot)}>Replay its message</button>
                  <button className="btn sm" onClick={() => fault('heal')}>Repair robot</button>
                  <button className={`btn sm ${controller.tool === 'block' ? 'lime' : ''}`} onClick={() => setTool('block')}>Drop a pallet</button>
                </div>
                <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
                  Faults are injected into the <b>physical world</b> only. Robots are never told — they must notice through heartbeats, lidar and plan-vs-reality checks.
                </p>
              </Section>

              <Section n="07" title="View" tourId="view">
                <Toggle label="Space-time ribbons" on={controller.view.ribbons} onChange={(v) => { controller.view.ribbons = v; if (v && cam === 'top') setCam('iso'); controller.notify(); }} help={<>Each robot’s reserved future (next H seconds) drawn as a ribbon rising one layer per second. The reservation table made visible: no two ribbons share a square at the same height.</>} />
                <Toggle label="Planned paths" on={controller.view.paths} onChange={(v) => { controller.view.paths = v; controller.notify(); }} />
                <Toggle label="P2P packets" on={controller.view.packets} onChange={(v) => { controller.view.packets = v; controller.notify(); }} help={<>Heartbeats in flight this second (thinned for readability; all shown for the selected robot). Red = lost, magenta = forged / replayed.</>} />
                <Toggle label="Protected zones (unknown ≠ free)" on={controller.view.zones} onChange={(v) => { controller.view.zones = v; controller.notify(); }} help={<>Red cells are reserved “for all time” by at least one robot because the robot there is silent, untrusted or unseen.</>} />
                <Toggle label="Congestion heatmap" on={controller.view.heat} onChange={(v) => { controller.view.heat = v; controller.notify(); }} />
                <Toggle label="Robot labels" on={controller.view.labels} onChange={(v) => { controller.view.labels = v; controller.notify(); }} />
                <div className="ctl" style={{ marginTop: 8 }}>
                  <div className="ctl-head">
                    Belief view
                    <Help title="Belief view">Show protected zones exactly as one robot believes them — proof that each robot reasons from its own local, signed information.</Help>
                  </div>
                  <select value={controller.beliefOf} onChange={(e) => { controller.beliefOf = Number(e.target.value); controller.notify(); }}>
                    <option value={-1}>Union of all robots</option>
                    {sim.robots.map((r) => (
                      <option key={r.id} value={r.id}>
                        As {r.name} believes
                      </option>
                    ))}
                  </select>
                </div>
              </Section>
            </aside>

            {/* ================================================== CENTER: twin */}
            <main className="wb-center">
              <div className="toolbar">
                <div className="tb-transport" data-tour="play">
                  <button className="tb-play" onClick={() => { controller.playing = !controller.playing; controller.notify(); }} title="Play / pause (Space)" aria-label={controller.playing ? 'Pause' : 'Play'}>
                    {controller.playing ? Icon.pause : Icon.play}
                  </button>
                  <button className="tb-mini" onClick={() => controller.stepOnce()} title="Step one second (→)" aria-label="Step">
                    {Icon.step}
                  </button>
                  <button className="tb-mini" onClick={() => controller.reset()} title="Restart from t = 0 (R)" aria-label="Restart">
                    {Icon.reset}
                  </button>
                </div>
                <span className="tb-div" />
                <HoverSelect<number>
                  label="Speed"
                  icon={<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M12 14l4-4" /><path d="M3.3 17a9 9 0 1 1 17.4 0" /></svg>}
                  value={controller.ticksPerSecond}
                  options={[
                    { v: 1, label: '0.5×', hint: '1 s of warehouse per 1 s' },
                    { v: 2, label: '1×', hint: 'default · 2 ticks / s' },
                    { v: 4, label: '2×', hint: '4 ticks / s' },
                    { v: 8, label: '4×', hint: '8 ticks / s' },
                  ]}
                  onPreview={(v) => { controller.ticksPerSecond = v; controller.notify(); }}
                  onChange={(v) => { controller.ticksPerSecond = v; controller.notify(); }}
                />
                <HoverSelect<Tool>
                  label="Tool"
                  tourId="tools"
                  icon={<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M4 4l7 17 2-7 7-2z" /></svg>}
                  value={controller.tool}
                  options={[
                    { v: 'select', label: 'Select', hint: 'click robots to inspect' },
                    { v: 'block', label: 'Drop pallet', hint: 'block / clear an aisle cell' },
                    { v: 'deadzone', label: 'Dead zone', hint: 'paint 90% packet loss' },
                    { v: 'order', label: 'Urgent order', hint: 'click pickup, then drop' },
                  ]}
                  onChange={setTool}
                />
                <HoverSelect<CamMode>
                  label="View"
                  icon={<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>}
                  value={cam}
                  options={[
                    { v: 'iso', label: 'Isometric', hint: 'whole floor' },
                    { v: 'top', label: 'Top-down', hint: 'plan view' },
                    { v: 'low', label: 'Low angle', hint: 'see rack depth' },
                    { v: 'follow', label: 'Follow robot', hint: sel >= 0 ? `following R${sel + 1}` : 'select a robot first' },
                  ]}
                  onPreview={(v) => setCam(v)}
                  onChange={(v) => setCam(v)}
                />
                <span className="tb-status">
                  <span className="dot" style={!controller.playing ? { background: '#777', boxShadow: 'none' } : undefined} />
                  <b>{cfg.planner === 'anvaya' ? 'ANVAYA' : 'Stop-and-wait'}</b>
                  <span className="mono">t {sim.t}s</span>
                  <span className="tb-sep" />
                  <span>{sim.robots.length} AMRs</span>
                  <span className="tb-sep" />
                  <span style={{ color: sim.m.collisions ? '#f87171' : undefined }}>{sim.m.collisions} contacts</span>
                  <span className="tb-sep" />
                  <span style={{ color: sim.m.estops ? '#fb923c' : undefined }}>{sim.m.estops} e-stops</span>
                </span>
                <label className={`toggle tb-compare ${controller.compare ? 'on' : ''}`} data-tour="compare" onClick={() => controller.setCompare(!controller.compare)} title="Run the identical day with the stop-and-wait baseline side by side">
                  <span className="sw" />
                  Compare
                </label>
              </div>

              <div className={`canvas-wrap ${controller.compare ? 'split' : ''}`} data-tour="canvas">
                <div className="canvas-cell" data-tool={controller.tool}>
                  <Twin loadId={controller.loadId} cam={cam} camNonce={camNonce} />
                  {controller.tool !== 'select' && (
                    <div className="hud tool-hint">
                      {controller.tool === 'block' && 'Click a floor square to drop / clear a pallet. Robots will discover it with lidar.'}
                      {controller.tool === 'deadzone' && 'Click to paint a 3×3 Wi-Fi dead zone (90% packet loss). Click inside one to remove it.'}
                      {controller.tool === 'order' && (controller.orderDraft.pickup === null ? 'Click the pickup square for an URGENT order.' : 'Now click the drop-off square.')}
                      <button className="btn sm" style={{ marginLeft: 10 }} onClick={() => setTool('select')}>
                        Done
                      </button>
                    </div>
                  )}
                  {lastCaption && <div className="hud caption">{lastCaption.text}</div>}
                  {selTruth && (
                    <div className="robot-pop" role="dialog" aria-label={`${selTruth.name} details`}>
                      <Inspector key={sel} i={sel} agent={selAgent} onFollow={() => setCam('follow')} />
                    </div>
                  )}
                  {!controller.compare && <Minimap />}
                  <div className="hud legend">
                    {Object.entries(ACTION_COLOR).map(([k, c]) => (
                      <span key={k}>
                        <i style={{ background: c }} />
                        {k.toLowerCase()}
                      </span>
                    ))}
                    <span title="A pallet dropped in an aisle: robots discover it with lidar and route around it">
                      <i style={{ background: 'repeating-linear-gradient(45deg,#fbbf24 0 3px,#141414 3px 6px)', borderRadius: 2 }} />
                      pallet (blocked aisle)
                    </span>
                    <span title="Cells protected because a robot there is silent, untrusted or unseen (unknown ≠ free)">
                      <i style={{ background: '#ef4444', borderRadius: 2 }} />
                      protected / blocked
                    </span>
                  </div>
                </div>
                {controller.compare && controller.twin && (
                  <div className="canvas-cell">
                    <Twin which="twin" loadId={controller.loadId} cam={cam === 'follow' ? 'iso' : cam} camNonce={camNonce} />
                    <div className="hud tl">
                      <span className="pill">{controller.twin.cfg.planner === 'anvaya' ? 'ANVAYA' : 'Stop-and-wait'} twin · t = {controller.twin.t}s</span>
                      <span className="pill">{controller.twin.m.tasksDone} delivered</span>
                      <span className="pill" style={{ color: controller.twin.m.estops ? '#fb923c' : undefined }}>
                        {controller.twin.m.estops} emergency stops
                      </span>
                    </div>
                  </div>
                )}
              </div>

              <Timeline />
              {controller.compare && controller.twin && <CompareStrip />}
            </main>

            {/* ================================================== RIGHT: insight */}
            <aside className="wb-right scroll-y">
              <Metrics />
              <FleetList />
              <div className="panel-block" data-tour="log">
                <div className="panel-title">
                  Decision log
                  <Help title="Decision log">Events reported by the robots themselves (deduplicated when many robots report the same thing — the ×N count). Click an entry to select the robot.</Help>
                </div>
                <div className="seg" style={{ marginBottom: 10 }}>
                  {LOG_FILTERS.map((f) => (
                    <button key={f.id} className={logFilter === f.id ? 'on' : ''} onClick={() => setLogFilter(f.id)}>
                      {f.label}
                    </button>
                  ))}
                </div>
                <DecisionLog filter={logFilter} />
              </div>
            </aside>
          </div>
        </div>
      </div>
      <DocsModal open={docs} onClose={() => setDocs(false)} />
      <Tour steps={TOUR} open={tour} onClose={() => setTour(false)} />
    </div>
  );
}

function Metrics() {
  const sim = controller.sim;
  const m = sim.m;
  const hist = sim.history;
  return (
    <div className="panel-block">
      <div className="panel-title">
        Live fleet metrics
        <span className="muted mono" style={{ marginLeft: 'auto', fontSize: 11 }}>
          {controller.stepMs.toFixed(1)} ms / tick
        </span>
      </div>
      <div className="kpi-grid">
        <Kpi tone="lime" k="Delivered" v={m.tasksDone} s={`of ${m.tasksCreated} orders`} help="Orders physically picked and dropped (ground truth)." />
        <Kpi tone="mint" k="Throughput" v={m.throughputPer100.toFixed(1)} s="orders / 100 s" />
        <Kpi tone={m.collisions ? 'coral' : 'silver'} k="Physical contacts" v={m.collisions} help="Two bodies in one square or passing through each other. Checked by the world every tick." />
        <Kpi tone={m.estops ? 'coral' : 'silver'} k="Emergency stops" v={m.estops} help="Times the physical Level-1 safety field had to brake a robot — i.e. the coordination layer failed to prevent a near-miss." />
        <Kpi k="Decision agreement" v={`${(m.agreement * 100).toFixed(0)}%`} s="replicated, no server" help="How often a robot's replicated fleet decision for a predecessor matched what that robot then actually did — agreement reached without any central coordinator." />
        <Kpi k="Coordination scope" v={m.avgCluster.toFixed(2)} s="robots per decision" help="Average size of the conflict cluster a robot coordinates with. Near 1 = robots only coordinate when they genuinely interact." />
        <Kpi k="Mean order time" v={`${m.meanCompletion.toFixed(0)}s`} s={`p95 ${m.p95Completion}s`} />
        <Kpi k="Waiting" v={m.waitTicks} s={`robot-s · fairness ${m.fairness.toFixed(2)}`} help="Robot-seconds spent standing still while having somewhere to go. Fairness = Jain's index over robots (1 = perfectly even)." />
        <Kpi k="Security rejects" v={m.securityRejects} s={`${m.isolations} isolations`} />
        <Kpi k="Radio" v={m.msgsSent} s={`${m.msgsDropped} lost / dead-zone`} />
      </div>
      <div className="spark-row">
        <div>
          <div className="muted" style={{ fontSize: 11 }}>Delivered over time</div>
          <Sparkline data={hist.map((h) => h.done)} />
        </div>
        <div>
          <div className="muted" style={{ fontSize: 11 }}>Cumulative waiting</div>
          <Sparkline data={hist.map((h) => h.wait)} color="#fbbf24" />
        </div>
      </div>
    </div>
  );
}

function CompareStrip() {
  const a = controller.sim.m;
  const b = controller.twin!.m;
  const rows: [string, number, number, boolean][] = [
    ['Delivered', a.tasksDone, b.tasksDone, true],
    ['Waiting (robot-s)', a.waitTicks, b.waitTicks, false],
    ['Emergency stops', a.estops, b.estops, false],
    ['Long stalls', a.deadlocks, b.deadlocks, false],
    ['Mean order time (s)', Math.round(a.meanCompletion), Math.round(b.meanCompletion), false],
  ];
  return (
    <div className="compare-strip">
      {rows.map(([k, x, y, hi]) => {
        const better = hi ? x >= y : x <= y;
        return (
          <div key={k} className="cmp">
            <div className="muted" style={{ fontSize: 11 }}>{k}</div>
            <div>
              <b style={{ color: better ? 'var(--lime)' : 'var(--text)' }}>{x}</b>
              <span className="muted"> vs </span>
              <span>{y}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function FleetList() {
  const sim = controller.sim;
  return (
    <div className="panel-block">
      <div className="panel-title">
        Fleet status
        <span className="muted" style={{ fontSize: 11, marginLeft: 'auto' }}>click a card to inspect</span>
      </div>
      <div className="fleet-cards">
        {sim.robots.map((r, i) => {
          const a = sim.agents[i];
          const color = ROBOT_COLORS[i % ROBOT_COLORS.length];
          // Trust in this robot, averaged over what its peers believe (each peer keeps its own score).
          let tSum = 0;
          let tN = 0;
          for (const o of sim.agents) {
            if (o === a || !(o instanceof AnvayaAgent)) continue;
            const p = o.peers.get(i);
            if (p) {
              tSum += p.trust;
              tN++;
            }
          }
          const trust = tN ? tSum / tN : 1;
          const faults = [r.faults.blackoutUntil >= 0 && 'NO RADIO', r.faults.motor && 'DRIVE FAULT', r.faults.slow && 'DEGRADED', r.faults.rogue && 'COMPROMISED', r.quarantined && 'QUARANTINED'].filter(Boolean) as string[];
          return (
            <button key={r.id} className={`fleet-card ${controller.selected === i ? 'on' : ''}`} style={{ boxShadow: `inset 4px 0 0 ${color}` }} onClick={() => { controller.selected = i; controller.notify(); }}>
              <div className="fc-head">
                <span className="fc-id" style={{ background: color }}>{r.name}</span>
                <span className="muted mono" style={{ fontSize: 10.5 }}>{a.task ? `${a.task.id} · ${a.task.prio}` : a.mode.replace('_', ' ')}</span>
                <span className="act" style={{ marginLeft: 'auto', color: faults.length ? '#f87171' : ACTION_COLOR[r.action] }}>{faults[0] ?? r.action}</span>
              </div>
              <div className="fc-grid">
                <span className="muted">Position</span><b className="mono">{sim.map.label(r.pos)}</b>
                <span className="muted">Target</span><b className="mono">{sim.map.label(a.goal)}</b>
              </div>
              <div className="fc-bar"><span className="muted">Trust</span><div className="tbar"><div style={{ width: `${trust * 100}%`, background: trust < 0.4 ? '#f87171' : trust < 0.9 ? '#fbbf24' : 'var(--lime)' }} /></div><span className="mono">{trust.toFixed(2)}</span></div>
              <div className="fc-bar"><span className="muted">Battery</span><div className="tbar"><div style={{ width: `${r.battery}%`, background: r.battery < 25 ? '#f87171' : '#38bdf8' }} /></div><span className="mono">{Math.round(r.battery)}%</span></div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Inspector({ i, agent, onFollow }: { i: number; agent: AnvayaAgent | null; onFollow: () => void }) {
  const sim = controller.sim;
  const r = sim.robots[i];
  const a = sim.agents[i];
  const color = ROBOT_COLORS[i % ROBOT_COLORS.length];
  const beliefs = agent ? agent.beliefs() : [];
  const prec = agent ? agent.debug.precedence.filter((p) => p.a === i || p.b === i) : [];
  const faults = [r.faults.blackoutUntil >= 0 && 'radio down', r.faults.slow && 'motors degraded', r.faults.motor && 'drive failed', r.faults.rogue && 'compromised', r.quarantined && 'quarantined'].filter(Boolean);
  return (
    <div className="panel-block inspector">
      <div className="panel-title">
        <span className="sw" style={{ background: color, width: 12, height: 12 }} />
        {r.name} · {a.mode.replace('_', ' ')}
        <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={onFollow}>Follow</button>
        <button className="btn sm" onClick={() => { controller.selected = -1; controller.notify(); }}>✕</button>
      </div>
      <div className="why" style={{ borderColor: ACTION_COLOR[r.action] }}>
        <div className="why-act" style={{ color: ACTION_COLOR[r.action] }}>{r.action}</div>
        <div>{r.reason}</div>
      </div>
      <div className="insp-grid">
        <div><span className="muted">Task</span><b>{a.task ? `${a.task.id} · ${a.task.prio}` : '—'}</b></div>
        <div><span className="muted">Position</span><b className="mono">{sim.map.label(r.pos)}</b></div>
        <div><span className="muted">Goal</span><b className="mono">{sim.map.label(a.goal)}</b></div>
        <div><span className="muted">Waiting age</span><b>{a.waitAge}s</b></div>
        <div><span className="muted">Speed model</span><b>{a.moveTicks > 1 ? 'half (self-diagnosed)' : 'nominal'}</b></div>
        <div>
          <span className="muted">Battery</span>
          <div className="batt"><div style={{ width: `${r.battery}%`, background: r.battery < 25 ? '#f87171' : 'var(--lime)' }} /></div>
        </div>
      </div>
      {faults.length > 0 && (
        <div className="faults">
          {faults.map((f) => (
            <span key={String(f)} className="pill" style={{ color: '#fca5a5', borderColor: 'rgba(248,113,113,.4)' }}>{f}</span>
          ))}
        </div>
      )}
      {agent && (
        <>
          <div className="subhead" style={{ marginTop: 14 }}>
            Coordinating with
            <Help title="Conflict cluster">The robots this one currently has a predicted space-time conflict with (its cluster), in the order they plan. Everyone else is ignored — coordination is local.</Help>
          </div>
          <div className="chips">
            {agent.debug.order.map((id) => (
              <span key={id} className="pill" style={{ borderColor: ROBOT_COLORS[id % ROBOT_COLORS.length] }}>
                {id === i ? 'me' : `R${id + 1}`}
              </span>
            ))}
          </div>
          {prec.length > 0 && (
            <>
              <div className="subhead" style={{ marginTop: 12 }}>Precedence decisions (fleet cost)</div>
              {prec.slice(0, 4).map((p, k) => {
                const other = p.a === i ? p.b : p.a;
                const me = p.a === i;
                return (
                  <div key={k} className="prec">
                    <b>{p.winner === i ? 'I go first' : `R${other + 1} goes first`}</b>
                    <span className="muted"> at {sim.map.label(p.cell)} · {p.basis}</span>
                    {p.basis === 'fleet-cost' || p.basis === 'held' ? (
                      <div className="mono" style={{ fontSize: 11.5 }}>
                        me-first J = {(me ? p.costAFirst : p.costBFirst).toFixed(1)} · R{other + 1}-first J = {(me ? p.costBFirst : p.costAFirst).toFixed(1)}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </>
          )}
          <div className="subhead" style={{ marginTop: 12 }}>
            What {r.name} believes about its peers
            <Help title="Local beliefs">Built only from signed heartbeats and its own lidar. Each robot keeps its own trust score for every peer — there is no shared database.</Help>
          </div>
          <div className="beliefs">
            {beliefs.map((b) => (
              <div key={b.id} className="belief">
                <span className="sw" style={{ background: ROBOT_COLORS[b.id % ROBOT_COLORS.length] }} />
                <b>R{b.id + 1}</b>
                <span className={`health h-${b.health.toLowerCase()}`}>{b.health}</span>
                <div className="tbar"><div style={{ width: `${b.trust * 100}%`, background: b.trust < 0.4 ? '#f87171' : b.trust < 0.9 ? '#fbbf24' : 'var(--lime)' }} /></div>
                <span className="mono" style={{ fontSize: 11, width: 34, textAlign: 'right' }}>{b.trust.toFixed(2)}</span>
              </div>
            ))}
          </div>
          <button className="btn sm" style={{ marginTop: 10 }} onClick={() => { controller.beliefOf = controller.beliefOf === i ? -1 : i; controller.notify(); }}>
            {controller.beliefOf === i ? 'Exit belief view' : `See the world as ${r.name} believes`}
          </button>
        </>
      )}
    </div>
  );
}

function DecisionLog({ filter }: { filter: string }) {
  const sim = controller.sim;
  const f = LOG_FILTERS.find((x) => x.id === filter);
  const items = useMemo(() => {
    const src = sim.log.slice(-400);
    const out = f && f.kinds ? src.filter((l) => f.kinds!.includes(l.kind)) : src;
    return out.slice(-120).reverse();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sim.log.length, sim.t, filter, sim]);
  if (items.length === 0) return <div className="muted" style={{ fontSize: 13 }}>Press play — events will appear here as robots decide.</div>;
  return (
    <div className="log">
      {items.map((l, k) => (
        <button
          key={k}
          className="log-row"
          onClick={() => {
            if (l.robot >= 0) {
              controller.selected = l.robot;
              controller.notify();
            }
          }}
        >
          <span className="mono t">{l.t}s</span>
          <i style={{ background: KIND_COLOR[l.kind] ?? '#999' }} />
          <span className="txt">
            {l.text}
            {l.count > 1 && <span className="cnt">×{l.count}</span>}
          </span>
        </button>
      ))}
    </div>
  );
}
