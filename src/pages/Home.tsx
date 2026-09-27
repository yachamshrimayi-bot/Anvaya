import type React from 'react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { summarize, type TrialResult } from '../engine/benchmark';
import { controller, ROBOT_COLORS } from '../sim/controller';
import { runPool } from '../sim/benchPool';
import { HeroScene } from '../three/HeroScene';
import { ScrollRobot } from '../three/ScrollRobot';
import { Twin } from '../three/Twin';
import { DocsModal } from '../ui/Docs';
import { Icon, TeX, useReveal } from '../ui/kit';
import { Nav } from '../ui/Nav';

function useSim() {
  return useSyncExternalStore(
    (cb) => controller.subscribe(cb),
    () => controller.version,
  );
}

/** Tiny self-updating readouts: only these re-render when the live twin ticks. */
function Live({ render }: { render: () => React.ReactNode }) {
  useSim();
  return <>{render()}</>;
}

function SpinBadge({ onClick }: { onClick: () => void }) {
  const txt = 'Scroll · follow the robot · Scroll · follow the robot · ';
  return (
    <div className="spin-badge" onClick={onClick} role="button" aria-label="Scroll down">
      <svg className="ring" viewBox="0 0 100 100">
        <defs>
          <path id="circ" d="M50,50 m-38,0 a38,38 0 1,1 76,0 a38,38 0 1,1 -76,0" />
        </defs>
        <text fontSize="8.4" fill="#e9e9e4" letterSpacing="1.6" fontFamily="JetBrains Mono Variable, monospace">
          <textPath href="#circ">{txt}</textPath>
        </text>
      </svg>
      <span style={{ color: '#fff' }}>{Icon.down}</span>
    </div>
  );
}

const LOOP = [
  { k: 'OBSERVE', t: 'Signed P2P heartbeats', d: 'Every tick each robot broadcasts position, intent and liveness, signed with Ed25519. Lidar sees neighbours directly.', c: 'silver', i: Icon.mesh },
  { k: 'PREDICT', t: 'Future space-time occupancy', d: 'Each robot projects everyone’s path 16 s ahead and builds a conflict graph — only interacting robots coordinate.', c: 'coral', i: Icon.predict },
  { k: 'RESERVE', t: 'Time slots on aisles & nodes', d: 'Space-Time A* books squares per second, with a headway gap. Unknown ≠ free: silent robots keep their cells.', c: 'mint', i: Icon.reserve },
  { k: 'DECIDE', t: 'Fleet-wide cost + fairness', d: 'For every conflict both orders of passage are re-planned; the one that costs the fleet least wins. Waiting age prevents starvation.', c: 'lime', i: Icon.cost },
  { k: 'EXECUTE', t: 'Go · wait · yield · re-route', d: 'Robots move only into cells they already promised; a lidar right-of-way gate makes collisions provably impossible.', c: 'silver', i: Icon.arrow },
  { k: 'VERIFY', t: 'Plan vs reality · trust', d: 'Deviations, impossible motion or lies lower trust. Below 0.40 a robot is isolated and its task re-auctioned.', c: 'coral', i: Icon.shield },
];

export default function Home() {
  const nav = useNavigate();
  const pointer = useRef({ x: 0, y: 0 });
  const [scrollY, setScrollY] = useState(0);
  const [docs, setDocs] = useState(false);
  const pageRef = useReveal<HTMLDivElement>();
  const [bench, setBench] = useState<TrialResult[]>([]);
  const [benchDone, setBenchDone] = useState(false);
  const benchRef = useRef<HTMLDivElement>(null);

  // live twin on the home page (same engine as the workbench)
  useEffect(() => {
    if (controller.scenarioId !== 'rush') controller.loadScenario('rush');
    controller.start();
    controller.ticksPerSecond = 1.5;
    controller.playing = true;
    return () => {
      controller.playing = false;
    };
  }, []);

  useEffect(() => {
    const onScroll = () => setScrollY(window.scrollY);
    const onMove = (e: PointerEvent) => {
      pointer.current.x = e.clientX / window.innerWidth;
      pointer.current.y = e.clientY / window.innerHeight - 0.5;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('pointermove', onMove);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('pointermove', onMove);
    };
  }, []);

  // live mini-benchmark once the results section scrolls into view
  useEffect(() => {
    const el = benchRef.current;
    if (!el) return;
    let cancel: (() => void) | null = null;
    const io = new IntersectionObserver((es) => {
      if (es[0].isIntersecting && !cancel) {
        const jobs = [];
        for (const family of ['dense', 'lanes', 'storm']) for (let seed = 1; seed <= 4; seed++) for (const variant of ['anvaya', 'baseline']) jobs.push({ family, seed, variant });
        cancel = runPool(jobs, (r) => setBench((b) => [...b, r]), () => setBenchDone(true));
      }
    });
    io.observe(el);
    return () => {
      io.disconnect();
      cancel?.();
    };
  }, []);

  const sim = controller.sim;
  const a = summarize(bench, 'anvaya');
  const b = summarize(bench, 'baseline');
  const par = (k: number) => ({ transform: `translate3d(0, ${scrollY * k}px, 0)` });

  return (
    <div className="page home" ref={pageRef}>
      <ScrollRobot />
      <div className="home-content" data-lane-content>
        {/* ================================================= HERO */}
        <div className="frame hero-frame">
          <div className="inner hero">
            <Nav />
            <div className="hero-grid">
              <h1 className="display hero-title" style={par(-0.06)}>
                Keep the Fleet
                <br />
                <span className="hero-accent">Moving.</span>
              </h1>
              <div className="hero-side" style={par(-0.03)}>
                <p className="hero-copy">
                  ANVAYA is a decentralized, predictive traffic layer for AMR fleets. Robots share <b>signed intent</b> peer-to-peer and negotiate shared space and time on the edge — <b>no central server</b>.
                </p>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                  <button className="btn lime lg" onClick={() => nav('/workbench')}>
                    Launch Workbench {Icon.arrow}
                  </button>
                  <button className="btn lg ghost" onClick={() => setDocs(true)}>
                    Read the math
                  </button>
                </div>
              </div>
            </div>
            <div className="hero-3d" style={par(0.12)}>
              <HeroScene pointer={pointer} active={scrollY < 1100} />
            </div>
            <div className="hero-cards">
              <div className="pastel coral hc hc1" style={par(-0.1)}>
                <div className="icon-bubble">{Icon.predict}</div>
                <h4>Predict, then reserve</h4>
                <p>Conflicts are found from future space-time occupancy — not just proximity.</p>
              </div>
              <div className="pastel mint hc hc2" style={par(-0.16)}>
                <div className="icon-bubble">{Icon.cost}</div>
                <h4>Fleet-wide cost</h4>
                <p>Pick the move that saves the fleet time, even if one robot waits.</p>
              </div>
              <div className="pastel silver hc hc3" style={par(-0.22)}>
                <div className="icon-bubble">{Icon.shield}</div>
                <h4>Isolate, don’t stop</h4>
                <p>Ed25519 trust contains a faulty robot; everyone else keeps moving.</p>
              </div>
            </div>
            <div className="hero-stat" data-lane="start">
              <div className="display stat-num"><Live render={() => controller.sim.m.collisions} /></div>
              <div>
                <div className="avatars">
                  {sim.robots.slice(0, 5).map((r, i) => (
                    <span key={r.id} style={{ background: ROBOT_COLORS[i], zIndex: 10 - i }}>
                      R{i + 1}
                    </span>
                  ))}
                </div>
                <div className="stat-label">
                  <span className="dot" /> <Live render={() => `collisions in the live twin below · ${controller.sim.robots.length} AMRs · t = ${controller.sim.t}s · ${controller.sim.m.tasksDone} orders delivered`} />
                </div>
              </div>
            </div>
          </div>
          <div className="hero-notch">
            <SpinBadge onClick={() => window.scrollTo({ top: window.innerHeight * 0.9, behavior: 'smooth' })} />
          </div>
        </div>

        <div className="lane-gap" data-lane="gap" />

        {/* ================================================= PROBLEM */}
        <section className="frame reveal">
          <div className="inner pad">
            <div className="two-col">
              <div>
                <div className="eyebrow">The real problem</div>
                <h2 className="h2" style={{ marginTop: 10 }}>
                  Paths don’t collide.
                  <br />
                  <span className="muted">Fleets do.</span>
                </h2>
                <p className="text-2" style={{ maxWidth: 520, marginTop: 18 }}>
                  Every robot can have a perfectly valid shortest path and the fleet still jams: two robots meet head-on in a single-lane aisle, a queue at one intersection spills into three others, a robot goes silent and the aisle it was in is assumed empty. The hard part is not finding paths — it is <b>managing shared future space under uncertainty</b>.
                </p>
              </div>
              <div className="cascade">
                {['Independent shortest paths', 'Shared aisles & junctions', 'Conflicts in space and time', 'Queues & congestion', 'Cascading fleet-wide delay'].map((s, i) => (
                  <div key={s} className="cascade-step reveal" style={{ transitionDelay: `${i * 90}ms` }}>
                    <span className="mono">0{i + 1}</span>
                    {s}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        <div className="lane-gap" data-lane="gap" />

        {/* ================================================= LOOP */}
        <section className="frame reveal">
          <div className="inner pad">
            <div className="eyebrow">What runs on every AMR</div>
            <h2 className="h2" style={{ marginTop: 10, maxWidth: 760 }}>
              One closed loop, six steps, repeated every second.
            </h2>
            <div className="loop-grid">
              {LOOP.map((s, i) => (
                <div key={s.k} className={`pastel ${s.c} loop-card reveal`} style={{ transitionDelay: `${i * 70}ms` }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div className="icon-bubble">{s.i}</div>
                    <span className="mono" style={{ fontSize: 12, opacity: 0.7 }}>
                      0{i + 1}
                    </span>
                  </div>
                  <div className="mono loop-k">{s.k}</div>
                  <h4>{s.t}</h4>
                  <p>{s.d}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <div className="lane-gap" data-lane="gap" />

        {/* ================================================= ARCHITECTURE */}
        <section className="frame reveal">
          <div className="inner pad">
            <div className="two-col">
              <div>
                <div className="eyebrow">Architecture</div>
                <h2 className="h2" style={{ marginTop: 10 }}>No central server. Every robot is the coordinator.</h2>
                <p className="text-2" style={{ marginTop: 16 }}>
                  Each AMR runs the same five modules on its edge computer and computes the <em>same fleet-level decision</em> from the same signed data — a replicated coordinator instead of a single point of failure. The dashboard only listens.
                </p>
                <div className="modules">
                  {['Local safety stop (Level-1 lidar field)', 'State + heartbeat (signed, sequenced)', 'Predict + reserve (Space-Time A*)', 'Decide (fleet cost) + P2P task auction', 'Trust + isolation (Ed25519, plan vs reality)'].map((m, i) => (
                    <div key={m} className="module">
                      <span className="mono">M{i + 1}</span>
                      {m}
                    </div>
                  ))}
                </div>
              </div>
              <MeshDiagram />
            </div>
          </div>
        </section>

        <div className="lane-gap" data-lane="gap" />

        {/* ================================================= LIVE */}
        <section className="frame reveal">
          <div className="inner live-block">
            <div className="live-head">
              <div>
                <div className="eyebrow">Not a video. Not a script.</div>
                <h2 className="h2" style={{ marginTop: 8 }}>This warehouse is running in your browser right now.</h2>
              </div>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <span className="pill">
                  <span className="dot" /> <Live render={() => `live · t = ${controller.sim.t}s`} />
                </span>
                <span className="pill"><Live render={() => `${controller.sim.m.tasksDone} delivered`} /></span>
                <span className="pill"><Live render={() => `${controller.sim.m.estops} emergency stops · ${controller.sim.m.collisions} collisions`} /></span>
                <button className="btn lime" onClick={() => nav('/workbench')}>
                  Take control {Icon.arrow}
                </button>
              </div>
            </div>
            <div className="live-canvas">
              <Twin loadId={controller.loadId} cam="iso" quality="low" interactive={false} />
            </div>
          </div>
        </section>

        <div className="lane-gap" data-lane="gap" />

        {/* ================================================= MATH */}
        <section className="frame reveal">
          <div className="inner pad">
            <div className="math-head">
              <div>
                <div className="eyebrow">The math</div>
                <h2 className="h2" style={{ marginTop: 10 }}>Six equations do the heavy lifting.</h2>
              </div>
              <button className="btn lime lg read-docs" onClick={() => setDocs(true)}>
                Read docs {Icon.arrow}
              </button>
            </div>
            <div className="math-grid">
              <MathCard title="Fleet-wide cost of letting A go first" tex={'J(A\\!\\to\\!B)=\\beta w_B\\Delta_B(1+\\varepsilon a_B)+\\gamma n_B\\Delta_B+\\zeta(1-\\tau_A)'} note="Both orders are re-planned; the cheaper one for the fleet wins." />
              <MathCard title="Route cost (Space-Time A*)" tex={'J(\\pi)=\\sum_t\\big[\\beta+\\min(\\eta+\\gamma C+\\zeta U+\\tfrac{\\delta}{2}\\mathbb 1_{\\text{off}},\\,0.9\\beta)\\big]+\\beta d(c_H,g)'} note="Time, energy, congestion, uncertainty and stability in one objective." />
              <MathCard title="Trust update & isolation" tex={'\\tau\\leftarrow\\mathrm{clamp}(\\tau+\\Delta),\\quad \\tau<0.40\\Rightarrow\\text{isolate}'} note="+0.02 per honest message; −0.30…−0.40 for impossible claims." />
              <MathCard title="Fairness (aging)" tex={'\\pi_i=w_i+\\varepsilon\\,a_i'} note="Waiting raises priority until nobody starves." />
              <MathCard title="Right-of-way gate (collision-free)" tex={'\\text{enter }c\\iff c\\text{ empty}\\wedge\\nexists j<i:\\;j\\sim c,\\ \\text{prom}_j\\in\\{c,?\\}'} note="With binding commitments this is a proof, not a heuristic." />
              <MathCard title="Adaptive safety margin" tex={'m(\\tau)=0\\;(\\tau\\ge0.9),\\;1\\;(\\ge0.7),\\;2\\;(<0.7)\\ \\text{ticks}'} note="Uncertain robots get wider reservations." />
            </div>
            <button className="docs-cta" onClick={() => setDocs(true)}>
              <span>
                <b>Read docs →</b> Full derivations, the collision-freedom proof, and every formula explained with nothing but addition and subtraction.
              </span>
              {Icon.arrow}
            </button>
          </div>
        </section>

        <div className="lane-gap" data-lane="gap" />

        {/* ================================================= RESULTS */}
        <section className="frame reveal" ref={benchRef}>
          <div className="inner pad">
            <div className="math-head">
              <div>
                <div className="eyebrow">Evidence, computed live</div>
                <h2 className="h2" style={{ marginTop: 10 }}>Same warehouse. Same orders. Two planners.</h2>
                <p className="text-2" style={{ maxWidth: 640 }}>
                  These numbers are being computed by Web Workers on your machine as you read ({bench.length}/24 trials{benchDone ? ', done' : ''}). The full 50-trial suite with ablations is one click away.
                </p>
              </div>
              <Link to="/benchmark" className="btn lg">
                Open the benchmark lab {Icon.arrow}
              </Link>
            </div>
            <div className="result-grid">
              <ResultBar label="Time to finish every order" unit="s" a={a.makespan.mean} b={b.makespan.mean} />
              <ResultBar label="Robot-seconds spent waiting" unit="" a={a.waitTicks.mean} b={b.waitTicks.mean} />
              <ResultBar label="Emergency stops needed" unit="" a={a.estops} b={b.estops} total />
              <ResultBar label="Runs with every order delivered" unit="%" a={a.completionRate * 100} b={b.completionRate * 100} higherBetter />
            </div>
          </div>
        </section>

        <div className="lane-gap" data-lane="gap" />

        {/* ================================================= CTA */}
        <section className="frame reveal">
          <div className="inner pad cta">
            <h2 className="h2">Break it yourself.</h2>
            <p className="text-2" style={{ maxWidth: 560, margin: '14px auto 26px' }}>
              Kill a robot’s radio, drop a pallet in an aisle, compromise a robot’s firmware, crank packet loss to 30% — then watch the fleet adapt, with every decision explained.
            </p>
            <button className="btn lime lg" onClick={() => nav('/workbench')}>
              Launch Workbench {Icon.arrow}
            </button>
          </div>
        </section>
        <footer className="footer">ANVAYA · SIH 2026 · PS 26123 — Edge-AI Based Distributed Fleet Coordination for AMRs in Smart Warehouses</footer>
      </div>
      <DocsModal open={docs} onClose={() => setDocs(false)} />
    </div>
  );
}

function MathCard({ title, tex, note }: { title: string; tex: string; note: string }) {
  return (
    <div className="math-card reveal">
      <div className="math-title">{title}</div>
      <div className="math-tex">
        <TeX block>{tex}</TeX>
      </div>
      <div className="muted" style={{ fontSize: 13 }}>
        {note}
      </div>
    </div>
  );
}

function ResultBar({ label, unit, a, b, total, higherBetter }: { label: string; unit: string; a: number; b: number; total?: boolean; higherBetter?: boolean }) {
  const max = Math.max(a, b, 1);
  const better = higherBetter ? a >= b : a <= b;
  const delta = higherBetter ? a - b : b > 0 ? ((b - a) / b) * 100 : 0;
  return (
    <div className="result">
      <div className="result-label">{label}</div>
      <div className="bar-row">
        <span className="bar-name">ANVAYA</span>
        <div className="bar">
          <div style={{ width: `${(a / max) * 100}%`, background: 'var(--lime-grad)' }} />
        </div>
        <span className="mono bar-val">{a.toFixed(0)}{unit}</span>
      </div>
      <div className="bar-row">
        <span className="bar-name">Stop-and-wait</span>
        <div className="bar">
          <div style={{ width: `${(b / max) * 100}%`, background: '#4a4a4a' }} />
        </div>
        <span className="mono bar-val">{b.toFixed(0)}{unit}</span>
      </div>
      {b > 0 && better && (
        <div className="result-delta">{higherBetter ? `+${delta.toFixed(0)} pts` : `${delta.toFixed(0)}% lower`}{total ? ' (total)' : ''}</div>
      )}
    </div>
  );
}

function MeshDiagram() {
  const nodes = [
    { x: 90, y: 70 },
    { x: 330, y: 60 },
    { x: 400, y: 230 },
    { x: 220, y: 320 },
    { x: 50, y: 240 },
  ];
  return (
    <svg viewBox="0 0 460 400" className="mesh-svg" aria-label="Peer-to-peer mesh of robots">
      {nodes.map((a, i) =>
        nodes.map((b, j) =>
          j > i ? (
            <g key={`${i}-${j}`}>
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#2a3322" strokeWidth={1.5} />
              <circle r={3.5} fill="#c9f46b">
                <animateMotion dur={`${2.2 + ((i + j) % 4) * 0.6}s`} repeatCount="indefinite" path={`M${a.x},${a.y} L${b.x},${b.y}`} />
              </circle>
            </g>
          ) : null,
        ),
      )}
      {nodes.map((n, i) => (
        <g key={i} transform={`translate(${n.x},${n.y})`}>
          <circle r={30} fill="#111" stroke={ROBOT_COLORS[i]} strokeWidth={2} />
          <circle r={38} fill="none" stroke={ROBOT_COLORS[i]} strokeOpacity={0.25}>
            <animate attributeName="r" values="30;44;30" dur="3s" repeatCount="indefinite" begin={`${i * 0.5}s`} />
            <animate attributeName="stroke-opacity" values="0.4;0;0.4" dur="3s" repeatCount="indefinite" begin={`${i * 0.5}s`} />
          </circle>
          <text textAnchor="middle" y={-2} fill="#f3f3f1" fontSize="14" fontWeight="700" fontFamily="Space Grotesk Variable">
            R{i + 1}
          </text>
          <text textAnchor="middle" y={13} fill="#8a8a85" fontSize="8.5" fontFamily="JetBrains Mono Variable">
            edge core
          </text>
        </g>
      ))}
      <g transform="translate(230,375)">
        <rect x={-92} y={-16} width={184} height={30} rx={15} fill="#161616" stroke="#333" />
        <text textAnchor="middle" y={4} fill="#b8b8b4" fontSize="11" fontFamily="JetBrains Mono Variable">
          dashboard · listens only
        </text>
      </g>
    </svg>
  );
}
