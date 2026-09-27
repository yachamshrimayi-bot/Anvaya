import { ReactNode, useEffect, useState } from 'react';
import { Modal, TeX } from './kit';

interface DocSection {
  id: string;
  title: string;
  formal: ReactNode;
  simple: ReactNode;
}

const Eq = ({ children }: { children: string }) => (
  <div className="doc-eq">
    <TeX block>{children}</TeX>
  </div>
);

const Simple = ({ children }: { children: ReactNode }) => <div className="doc-simple">{children}</div>;

/* Every equation below is the one the engine actually executes — file references point at the code. */
export const DOC_SECTIONS: DocSection[] = [
  {
    id: 'model',
    title: '0 · The world model',
    formal: (
      <>
        <p>
          The warehouse is a graph <TeX>{'G=(V,E)'}</TeX>: every free floor square (1.2 m) is a node <TeX>{'c\\in V'}</TeX>, and two nodes are joined when they share an edge. Time moves in ticks <TeX>{'t=0,1,2,\\dots'}</TeX> of 1 s. In one tick a robot either stays or moves to a neighbour, so it cruises at 1.2 m/s.
        </p>
        <Eq>{'p_i(t+1)\\in\\{p_i(t)\\}\\cup N(p_i(t))'}</Eq>
        <p>
          Each robot <TeX>{'i'}</TeX> knows only (a) its own sensors — position, lidar within 2 cells — and (b) the signed messages it receives. There is no server that sees everything (<code>engine/anvaya.ts</code>, <code>engine/sim.ts</code>).
        </p>
      </>
    ),
    simple: (
      <>
        Imagine the floor as a chessboard. Each robot stands on one square. Every second, each robot either stays where it is or steps one square forward, back, left or right — never diagonally, never two squares. A robot can see 2 squares around itself, and it can hear what other robots shout over the radio. That's all it knows.
      </>
    ),
  },
  {
    id: 'reserve',
    title: '1 · Space-time reservation table',
    formal: (
      <>
        <p>
          A reservation is a claim on a <em>square at a time</em>, not just a square. Each robot keeps its own table
        </p>
        <Eq>{'R:;V\\times\\{0,\\dots,H\\}\\to \\{\\text{robot id}\\}\\cup\\{\\varnothing\\}'}</Eq>
        <p>
          where <TeX>{'H'}</TeX> is the look-ahead horizon (default 16 ticks). A path is timed: <TeX>{'\\pi=(c_0,c_1,\\dots,c_H)'}</TeX> with <TeX>{'c_t'}</TeX> = square at tick <TeX>{'t'}</TeX>. Two timed paths conflict if they meet on a square or swap squares:
        </p>
        <Eq>{'\\exists t:; c^A_t=c^B_t \\quad\\text{or}\\quad (c^A_t=c^B_{t-1}\\wedge c^B_t=c^A_{t-1})'}</Eq>
        <p>
          ANVAYA adds a <b>headway</b> rule (a robot needs one empty tick before and after anyone else on that square): if <TeX>{'R(c,t)=i'}</TeX> then for every <TeX>{'j\\neq i'}</TeX>, <TeX>{'R(c,t\\pm1)\\neq j'}</TeX>. This rules out tail-gating and swaps in the plan itself (<code>planning.ts: spaceTimeAStar</code>).
        </p>
      </>
    ),
    simple: (
      <>
        Think of a hotel booking sheet, but for floor squares: “Square 12 — booked by Robot 3 at second 5.” Two robots can use the same square, just not at the same second. And to be extra safe, a square is left empty for 1 second between two different robots — like leaving a gap between cars.
        <br />
        <br />
        Example: Robot A books square 12 at seconds 5 and 6. Robot B may book square 12 at second 8 (6 + 1 gap + 1 = 8), but not at second 7.
      </>
    ),
  },
  {
    id: 'sta',
    title: '2 · Planning a route: Space-Time A* with the fleet cost',
    formal: (
      <>
        <p>Each robot searches over states (square, tick). An action is “wait” or “move to a neighbour”. The cost of a timed path is</p>
        <Eq>{'J(\\pi)=\\sum_{t=1}^{H} s_t + \\beta\\, d(c_H, g),\\qquad s_t=\\begin{cases}\\beta+\\min\\big(\\eta+\\gamma C(c_t)+\\zeta U(c_t)+\\tfrac{\\delta}{2}\\mathbb{1}[c_t\\notin\\pi^{\\text{prev}}],\\,0.9\\beta\\big) & \\text{move}\\\\[2pt] \\beta+0.2\\eta+\\epsilon_t & \\text{wait (not settled at goal)}\\end{cases}'}</Eq>
        <ul>
          <li><TeX>{'\\beta'}</TeX> — time (delay) weight: every tick not yet settled at the goal costs β.</li>
          <li><TeX>{'\\eta'}</TeX> — energy per move (a wait uses 0.2η).</li>
          <li><TeX>{'C(c)'}</TeX> — predicted congestion on square c (section 5).</li>
          <li><TeX>{'U(c)'}</TeX> — uncertainty near silent / untrusted robots (section 6).</li>
          <li><TeX>{'\\delta'}</TeX> — route-change penalty: stepping off the route I already announced (stability, no oscillation).</li>
          <li><TeX>{'\\epsilon_t=0.02\\,(H-t)/H'}</TeX> — a tiny extra on early waits: move or evacuate promptly rather than at the last moment.</li>
          <li><TeX>{'d(c_H,g)'}</TeX> — exact remaining distance after the horizon (breadth-first distance field, respects known blocked cells).</li>
        </ul>
        <p>Hard constraints are never priced — they are simply not expanded: a reserved square, a square another robot occupies one tick earlier or later (headway), or a swap.</p>
        <p>
          <b>Why cap the soft terms at 0.9β?</b> Claim: a planner never gains by postponing a move past the horizon. Proof: postponing one move replaces an in-horizon move <TeX>{'\\beta+x'}</TeX> (with <TeX>{'x\\le0.9\\beta'}</TeX>) by a wait <TeX>{'\\beta+0.2\\eta+\\epsilon_t'}</TeX> plus one more unit of terminal distance <TeX>{'\\beta'}</TeX>:
        </p>
        <Eq>{'(\\beta+0.2\\eta+\\epsilon_t+\\beta)-(\\beta+x)\\,=\\,\\beta-x+0.2\\eta+\\epsilon_t\\,\\ge\\,0.1\\beta+0.2\\eta>0.'}</Eq>
        <p>
          So “move now” is always strictly cheaper. Dancing back and forth is never cheaper than waiting either: two moves cost at least <TeX>{'2\\beta'}</TeX> plus energy, versus <TeX>{'2\\beta+0.4\\eta'}</TeX> for two waits, and the dance ends no closer. Without the cap, two robots facing each other can each plan “I'll move in 3 seconds” forever — we observed exactly that livelock in testing and this is the fix.
        </p>
      </>
    ),
    simple: (
      <>
        To choose a route, a robot adds up “points” for each second of the trip — lower is better:
        <br />• 1 point for every second it isn't at the goal yet,
        <br />• a tiny bit for battery used,
        <br />• a few extra points for squares that look busy, near a broken robot, or off the route it already promised.
        <br />
        <br />
        Example: Route 1 takes 10 seconds through a busy aisle: 10 + 3 extra = 13 points. Route 2 takes 11 seconds through a quiet aisle: 11 + 0 = 11 points. The robot picks Route 2 even though it is 1 second longer.
        <br />
        <br />
        The extra points are never allowed to add up to more than one second's worth for a single step. That way, “move now” always beats “wait and move later”.
      </>
    ),
  },
  {
    id: 'predict',
    title: '3 · Predicting conflicts: the conflict graph',
    formal: (
      <>
        <p>
          For every robot <TeX>{'j'}</TeX> it can hear, robot <TeX>{'i'}</TeX> predicts its desired timed path <TeX>{'D_j'}</TeX> (shortest route to <TeX>{'j'}</TeX>'s announced goal, expanded in time, shifted by the message age to compensate latency). An edge joins <TeX>{'j,k'}</TeX> in the conflict graph when
        </p>
        <Eq>{'\\exists\\,t\\le H,;|u|\\le m:; D_j(t)=D_k(t+u);\\text{ or they swap}'}</Eq>
        <p>
          with safety margin <TeX>{'m=\\max(m(\\tau_j),m(\\tau_k))'}</TeX> from trust (section 6). Robot <TeX>{'i'}</TeX> only coordinates the connected component (“cluster”) containing itself. Everything else keeps flowing untouched — “global coordination, local intervention”. The live metric <em>coordination scope</em> is the average cluster size.
        </p>
      </>
    ),
    simple: (
      <>
        Each robot draws, in its head, where everybody is heading for the next 16 seconds. If two drawings land on the same square at the same second, those two robots have a future problem — draw a line between them. Only robots joined by lines need to talk it over; everyone else just carries on.
        <br />
        <br />
        Example: 10 robots, but only Robot 2 and Robot 5 will meet at a corner in 6 seconds. Only those 2 negotiate. The other 8 never slow down.
      </>
    ),
  },
  {
    id: 'cost',
    title: '4 · Deciding who goes first: fleet-wide cost + fairness',
    formal: (
      <>
        <p>
          For a conflicting pair <TeX>{'(A,B)'}</TeX>, each robot actually re-plans both options with Space-Time A*: <TeX>{'\\Delta_B'}</TeX> = extra ticks B loses if A goes first, <TeX>{'\\Delta_A'}</TeX> = the reverse. The fleet cost of letting A pass first is
        </p>
        <Eq>{'J(A\\!\\to\\!B)=\\beta\\,w_B\\,\\Delta_B\\,(1+\\varepsilon a_B);+;\\gamma\\, n_B\\,\\Delta_B;+;\\zeta\\,(1-\\tau_A)'}</Eq>
        <ul>
          <li><TeX>{'w'}</TeX> — mission weight: LOW 1, NORMAL 2, HIGH 3, URGENT 5, idle 0.25.</li>
          <li><TeX>{'a'}</TeX> — waiting age: seconds already spent waiting on this leg. <TeX>{'\\varepsilon'}</TeX> is the aging factor (fairness).</li>
          <li><TeX>{'n_B'}</TeX> — downstream impact: how many other robots want B's square in the next 6 ticks (if B waits, it blocks them).</li>
          <li><TeX>{'\\tau_A'}</TeX> — trust in A: letting an uncertain robot go first through a shared square carries risk.</li>
        </ul>
        <p>
          Winner = the option with the lower fleet cost. Robots compute this from identical signed data, so they reach the same verdict without a referee; for the pair, the lower-id robot's announced decision is authoritative when views differ. The decision is then <b>kept for the life of the conflict</b> (it is only re-opened if the winner itself stops making progress), which prevents two robots from “dancing” in a single-lane aisle. At a shared station (same goal square) the rule becomes a queue: <TeX>{'w(1+0.25a)'}</TeX> decides, so nobody is overtaken forever.
        </p>
        <p>Effective priority, used for tie-breaks and ordering:</p>
        <Eq>{'\\pi_i = w_i + \\varepsilon\\, a_i'}</Eq>
      </>
    ),
    simple: (
      <>
        When two robots will meet, both ask: “If you go first, how much time do I lose? If I go first, how much do you lose?” — and they multiply by how important each job is.
        <br />
        <br />
        Example: Robot A carries an URGENT order (importance 5). Robot B carries a NORMAL order (importance 2).
        <br />• If A goes first, B loses 3 seconds: 2 + 2 + 2 = 6 points.
        <br />• If B goes first, A loses 2 seconds: 5 + 5 = 10 points.
        <br />6 is less than 10, so A goes first — the fleet loses less time overall.
        <br />
        <br />
        Fairness: every second a robot has already waited adds a little to its importance. A robot that has waited a long time eventually wins, even with a small job. Nobody waits forever.
      </>
    ),
  },
  {
    id: 'congestion',
    title: '5 · Predicted congestion field',
    formal: (
      <>
        <Eq>{'C_i(c)=\\sum_{j\\neq i};\\sum_{t=1}^{H}\\Big(1-\\frac{t}{H+1}\\Big)\\,\\mathbb{1}\\big[D_j(t)=c\\big]'}</Eq>
        <p>
          Squares that many robots are about to cross score high; near-future crossings count more than far ones. The planner pays <TeX>{'\\gamma C(c)'}</TeX> per step, which spreads traffic across parallel aisles before a queue forms (“if I send five robots through this corridor in the next 30 s, what happens?”).
        </p>
      </>
    ),
    simple: (
      <>
        Count how many robots plan to drive over each square soon. A square that 4 robots will cross gets 4 “busy points” (a bit less if they come later). Routes through busy squares look more expensive, so robots naturally spread out — like drivers taking a side street when the main road looks jammed.
      </>
    ),
  },
  {
    id: 'trust',
    title: '6 · Trust, liveness and “unknown ≠ free”',
    formal: (
      <>
        <p>Every robot keeps its own trust score <TeX>{'\\tau_j\\in[0,1]'}</TeX> for every peer, updated on each message:</p>
        <Eq>{'\\tau_j \\leftarrow \\operatorname{clamp}_{[0,1]}\\big(\\tau_j + \\Delta\\big),\\qquad \\Delta\\in\\{+0.02,\\,-0.05,\\,-0.25,\\,-0.30,\\,-0.35,\\,-0.40\\}'}</Eq>
        <p>
          +0.02 for a valid, consistent message; −0.05 when a robot's position drifts from its own announced intent (plan vs reality); −0.25 implausible bid; −0.30 impossible plan (jumps across the map); −0.35 impossible motion (teleport); −0.40 lidar contradiction. Silence costs −0.03 per tick down to a floor of 0.45 (silence alone never isolates). Messages whose Ed25519 signature fails, or whose sequence number does not increase (replay), are dropped without blaming the claimed sender.
        </p>
        <Eq>{'\\tau_j<\\theta=0.40;\\Rightarrow;\\text{isolate } j'}</Eq>
        <p>
          Isolation: j is barred from auctions, its claims are ignored, its task is re-auctioned, and the squares around wherever it physically is are reserved. If enough peers isolate it, its onboard safety controller stops the drive (quarantine). Re-admission needs 12 consistent messages, then trust re-starts at <TeX>{'\\theta+0.05'}</TeX>.
        </p>
        <p>Adaptive safety margin (in ticks) around a peer's reservations:</p>
        <Eq>{'m(\\tau)=\\begin{cases}0 & \\tau\\ge 0.9\\\\ 1 & 0.7\\le\\tau<0.9\\\\ 2 & \\tau<0.7\\end{cases}'}</Eq>
        <p>
          Liveness: a peer silent for more than <TeX>{'s'}</TeX> ticks (default 3) is STALE, beyond <TeX>{'3s'}</TeX> UNRESPONSIVE. Unknown ≠ free: every square of its last announced intent is reserved <em>for all times</em> until it is heard again.
        </p>
      </>
    ),
    simple: (
      <>
        Every robot gives every other robot a trust score from 0 to 1, starting at 1.
        <br />• Sends a good, honest message: +0.02.
        <br />• Claims it jumped 10 squares in one second: −0.35.
        <br />• Says it's in one place while my camera sees it somewhere else: −0.40.
        <br />
        <br />
        Example: a robot starts at 1.00. It lies twice: 1.00 − 0.30 = 0.70, then 0.70 − 0.35 = 0.35. Now 0.35 is below 0.40, so everyone stops believing it and steers around it.
        <br />
        <br />
        If a robot goes quiet, the others don't pretend its squares are empty. They keep every square it said it was going to use blocked off, until they hear from it again. Not knowing is treated as “occupied”, never as “free”.
      </>
    ),
  },
  {
    id: 'gate',
    title: '7 · Why robots cannot collide: commitment + right-of-way (proof)',
    formal: (
      <>
        <p>
          <b>Commitment.</b> With radio latency <TeX>{'L'}</TeX>, set <TeX>{'K=\\max(1,L)'}</TeX>. The heartbeat robot i signs at tick τ carries its intent <TeX>{'\\pi^{(\\tau)}_i'}</TeX>. Rule C: at tick t, robot i may move only into
        </p>
        <Eq>{'\\text{prom}_i(t)=\\pi^{(t-K)}_i[K+1]\\quad\\text{and only if}\\quad \\pi^{(t-K)}_i[K]=p_i(t)'}</Eq>
        <p>otherwise it stays. Its peers receive that exact heartbeat by tick t.</p>
        <p>
          <b>Right-of-way gate (rule G).</b> Robot i moves into square c at tick t only if (G1) no robot occupies c now (lidar), and (G2) there is no robot j with <TeX>{'j<i'}</TeX>, adjacent to c, whose promise is unknown to i or equals c.
        </p>
        <p>
          <b>Theorem.</b> If all robots follow C and G, no two robots ever occupy one square, and no two robots ever swap squares.
        </p>
        <p>
          <b>Proof.</b> <em>Swap:</em> a swap needs i to enter <TeX>{'p_j(t)'}</TeX> while j is there — forbidden by G1. <em>Vertex:</em> suppose <TeX>{'i<k'}</TeX> both enter an empty square c at tick t. Both were adjacent to c, hence within each other's 2-square lidar range, so each sees the other's exact position. Since k entered, G2 held for k: i's promise was known to k and <TeX>{'\\ne c'}</TeX>. But by C, i can only enter its promise, so i's promise was c — and k holds exactly that heartbeat (the one signed at t−K). Contradiction. ∎
        </p>
        <p>
          The simulator also gives every robot a physical Level-1 safety field (brake before contact) and checks the invariant after every tick. The benchmark reports how often that last layer had to intervene: stop-and-wait needs it hundreds of times; ANVAYA's protocol needs it zero times.
        </p>
      </>
    ),
    simple: (
      <>
        Two rules make crashes impossible:
        <br />
        <br />
        <b>Rule 1 — say it before you do it.</b> A robot may only step onto a square it announced one second earlier. No surprises.
        <br />
        <br />
        <b>Rule 2 — lowest number goes first.</b> If two robots next to the same empty square both announced it (or one of them didn't hear the other), the robot with the smaller number goes, and the other waits one second.
        <br />
        <br />
        Example: Robot 3 and Robot 7 both stand next to square 20. Robot 3 announced “square 20”. Robot 7 heard that, and 3 is smaller than 7, so Robot 7 waits. Robot 3 steps in. One square, one robot — every time.
      </>
    ),
  },
  {
    id: 'auction',
    title: '8 · Task auction without an auctioneer',
    formal: (
      <>
        <p>The warehouse system only announces orders (signed). Every free robot bids its own cost and puts the bid in its heartbeat:</p>
        <Eq>{'b_i(o)= d(p_i,\\text{pickup}_o)\\cdot \\mathrm{mv}_i + \\max(0,;45-\\text{battery}_i)\\cdot 0.5'}</Eq>
        <p>
          After the bid window (3 ticks) every robot runs the same rule on the bids it heard — orders in priority order, winner <TeX>{'\\arg\\min_i b_i'}</TeX>, ties to the lower id, each robot wins at most one order per round — so all robots elect the same winner independently. Conflicting claims resolve by (newer epoch, lower bid, lower id). If an owner goes unresponsive, faults, or is isolated before pickup, peers re-open the order with epoch+1.
        </p>
      </>
    ),
    simple: (
      <>
        A new order appears: “Pick up at shelf 14.” Every free robot says how far away it is. Robot 1: “I'm 6 squares away.” Robot 2: “12 squares.” Robot 3: “9 squares.” Everyone hears everyone, and everyone uses the same rule — the smallest number wins — so they all agree Robot 1 takes it, without a boss choosing. If Robot 1 breaks down before reaching the shelf, the others notice and run the auction again.
      </>
    ),
  },
  {
    id: 'metrics',
    title: '9 · How results are measured',
    formal: (
      <>
        <ul>
          <li><b>Makespan</b>: ticks until the last order of a finite batch is delivered (capped at 700).</li>
          <li><b>Waiting ticks</b>: Σ over robots of ticks spent standing still while having somewhere to go.</li>
          <li><b>Near-misses</b>: number of times the physical Level-1 safety field had to brake a robot.</li>
          <li><b>Physical contacts</b>: two bodies in one square or passing through each other (always checked; should be 0).</li>
          <li><b>Long stalls</b>: a robot with a goal that gets no closer to it for 30 ticks (deadlock or livelock).</li>
          <li>
            <b>Fairness</b> (Jain's index over per-robot waiting): <TeX>{'\\mathcal J=\\frac{(\\sum_i x_i)^2}{n\\sum_i x_i^2}\\in(0,1]'}</TeX>, 1 = perfectly even.
          </li>
          <li><b>Decision agreement</b>: share of predecessors' decisions that a robot replicated exactly before hearing them — a measure of how well the fleet agrees without a server.</li>
          <li>95% confidence interval of a mean over n trials: <TeX>{'\\bar x\\pm1.96\\,s/\\sqrt n'}</TeX>.</li>
        </ul>
      </>
    ),
    simple: (
      <>
        We run the exact same warehouse day twice — once with ANVAYA, once with the simple “stop if something is in front of you” method — and count:
        <br />• How long until all orders are delivered (smaller is better).
        <br />• How many seconds robots stood still (smaller is better).
        <br />• How many times emergency brakes were needed (smaller is better).
        <br />
        <br />
        Example: ANVAYA 198 seconds, stop-and-wait 574 seconds: 574 − 198 = 376 seconds saved on the same day.
      </>
    ),
  },
];

export function DocsModal({ open, onClose, initial }: { open: boolean; onClose: () => void; initial?: string }) {
  const [active, setActive] = useState(initial ?? DOC_SECTIONS[0].id);
  const [mode, setMode] = useState<'both' | 'simple' | 'formal'>('both');
  const sec = DOC_SECTIONS.find((s) => s.id === active) ?? DOC_SECTIONS[0];
  useEffect(() => {
    document.querySelector('.modal-body')?.scrollTo({ top: 0 });
  }, [active]);
  const idx = DOC_SECTIONS.indexOf(sec);
  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <div>
            <div className="eyebrow">Read the docs</div>
            <div className="h3">The mathematics behind ANVAYA — derived, then explained simply</div>
          </div>
          <div className="seg" style={{ marginLeft: 'auto', width: 300 }}>
            {(['both', 'formal', 'simple'] as const).map((m) => (
              <button key={m} className={mode === m ? 'on' : ''} onClick={() => setMode(m)}>
                {m === 'both' ? 'Side by side' : m === 'formal' ? 'Derivation' : 'Simple words'}
              </button>
            ))}
          </div>
        </div>
      }
    >
      <div className="docs">
        <nav className="docs-nav">
          {DOC_SECTIONS.map((s) => (
            <button key={s.id} className={s.id === active ? 'on' : ''} onClick={() => setActive(s.id)}>
              {s.title}
            </button>
          ))}
        </nav>
        <article className="docs-body">
          <h3 className="h3" style={{ marginBottom: 18 }}>
            {sec.title}
          </h3>
          <div className={`docs-cols ${mode}`}>
            {mode !== 'simple' && (
              <div className="doc-formal">
                <div className="doc-label">Derivation</div>
                {sec.formal}
              </div>
            )}
            {mode !== 'formal' && (
              <div>
                <div className="doc-label lime">Explained simply</div>
                <Simple>{sec.simple}</Simple>
              </div>
            )}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 28 }}>
            <button className="btn" disabled={idx === 0} onClick={() => setActive(DOC_SECTIONS[idx - 1].id)}>
              ← Previous
            </button>
            <button className="btn lime" disabled={idx === DOC_SECTIONS.length - 1} onClick={() => setActive(DOC_SECTIONS[idx + 1].id)}>
              Next →
            </button>
          </div>
        </article>
      </div>
    </Modal>
  );
}
