import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FAMILIES, pairedImprovement, summarize, VARIANTS, type TrialResult } from '../engine/benchmark';
import { runPool, type Job } from '../sim/benchPool';
import { DocsModal } from '../ui/Docs';
import { Help, Icon, Seg } from '../ui/kit';
import { Nav } from '../ui/Nav';
import { exportPdfReport } from '../ui/report';

const VCOLOR: Record<string, string> = {
  anvaya: '#c9f46b',
  baseline: '#6b6b66',
  'no-fleetcost': '#5eead4',
  'no-fairness': '#7dd3fc',
  'short-horizon': '#fb8f6b',
};

export default function Benchmark() {
  const nav = useNavigate();
  const [seeds, setSeeds] = useState(10);
  const [variants, setVariants] = useState<string[]>(['anvaya', 'baseline']);
  const [families, setFamilies] = useState<string[]>(FAMILIES.map((f) => f.id));
  const [results, setResults] = useState<TrialResult[]>([]);
  const [running, setRunning] = useState(false);
  const [total, setTotal] = useState(0);
  const [docs, setDocs] = useState(false);
  const [t0, setT0] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const cancel = useRef<(() => void) | null>(null);

  useEffect(() => () => cancel.current?.(), []);
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setElapsed((performance.now() - t0) / 1000), 200);
    return () => clearInterval(id);
  }, [running, t0]);

  const run = () => {
    cancel.current?.();
    const jobs: Job[] = [];
    for (const family of families) for (let seed = 1; seed <= seeds; seed++) for (const variant of variants) jobs.push({ family, seed, variant });
    setResults([]);
    setTotal(jobs.length);
    setRunning(true);
    setT0(performance.now());
    cancel.current = runPool(jobs, (r) => setResults((x) => [...x, r]), () => setRunning(false));
  };
  const stop = () => {
    cancel.current?.();
    setRunning(false);
  };

  const summaries = useMemo(() => variants.map((v) => summarize(results, v)), [results, variants]);
  const improvement = (metric: keyof TrialResult) => pairedImprovement(results, 'anvaya', 'baseline', metric);
  const hasPair = variants.includes('anvaya') && variants.includes('baseline') && results.length > 0;
  const download = () => {
    const blob = new Blob([JSON.stringify({ generatedAt: new Date().toISOString(), seeds, variants, families, results }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `anvaya-benchmark-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const toggle = (arr: string[], v: string, set: (x: string[]) => void) => set(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

  return (
    <div className="page">
      <div className="frame">
        <div className="inner">
          <Nav />
          <div className="bench">
            <div className="bench-hero">
              <div>
                <div className="eyebrow">Benchmark lab</div>
                <h1 className="h2" style={{ marginTop: 8 }}>
                  Run the evidence yourself.
                </h1>
                <p className="text-2" style={{ maxWidth: 680 }}>
                  Every trial builds a warehouse, a fleet, an order list and a fault timeline from its seed, then runs <b>each planner on the identical day</b>. Nothing is precomputed: the numbers below are produced by Web Workers on this machine with the same engine as the workbench (and as <code className="mono">npm run bench</code>).
                </p>
              </div>
              <div className="bench-run">
                <button className="btn lime lg" onClick={run} disabled={running || !variants.length || !families.length}>
                  {Icon.play} Run {families.length * seeds * variants.length} trials
                </button>
                {running && (
                  <button className="btn" onClick={stop}>
                    Stop
                  </button>
                )}
                {results.length > 0 && !running && (
                  <>
                    <button className="btn" onClick={() => exportPdfReport(results, variants, seeds, elapsed)} title="Opens the print dialog — choose “Save as PDF”">
                      Export PDF report
                    </button>
                    <button className="btn" onClick={download}>
                      Download raw JSON
                    </button>
                  </>
                )}
              </div>
            </div>

            <div className="bench-config">
              <div className="card">
                <div className="panel-title">
                  Families
                  <Help title="Trial families">Five kinds of warehouse day. Each family × seed is one trial, identical for every planner.</Help>
                </div>
                {FAMILIES.map((f) => (
                  <label key={f.id} className={`check ${families.includes(f.id) ? 'on' : ''}`} onClick={() => toggle(families, f.id, setFamilies)}>
                    <span className="box" />
                    <span>
                      <b>{f.title}</b>
                      <span className="muted" style={{ display: 'block', fontSize: 12 }}>{f.detail}</span>
                    </span>
                  </label>
                ))}
              </div>
              <div className="card">
                <div className="panel-title">
                  Planners & ablations
                  <Help title="Ablation study">Remove one ANVAYA component at a time to show what each contributes (solution doc §73).</Help>
                </div>
                {VARIANTS.map((v) => (
                  <label key={v.id} className={`check ${variants.includes(v.id) ? 'on' : ''}`} onClick={() => toggle(variants, v.id, setVariants)}>
                    <span className="box" style={variants.includes(v.id) ? { background: VCOLOR[v.id], borderColor: VCOLOR[v.id] } : undefined} />
                    <b>{v.title}</b>
                  </label>
                ))}
              </div>
              <div className="card">
                <div className="panel-title">Seeds per family</div>
                <Seg value={seeds} options={[4, 10, 20].map((v) => ({ v, label: `${v}` }))} onChange={setSeeds} />
                <p className="muted" style={{ fontSize: 12.5, marginTop: 12 }}>
                  10 seeds × 5 families = the 50 seeded trials cited in the submission. Trials cap at 700 s; a trial that does not deliver every order counts its makespan as 700.
                </p>
                {(running || results.length > 0) && (
                  <div style={{ marginTop: 14 }}>
                    <div className="bar">
                      <div style={{ width: `${(results.length / Math.max(1, total)) * 100}%`, background: 'var(--lime-grad)' }} />
                    </div>
                    <div className="muted mono" style={{ fontSize: 12, marginTop: 6 }}>
                      {results.length}/{total} trials · {elapsed.toFixed(1)} s · {navigator.hardwareConcurrency || '?'} CPU threads
                    </div>
                  </div>
                )}
              </div>
            </div>

            {hasPair && (
              <div className="headline-grid">
                <Headline v={`${(improvement('makespan') * 100).toFixed(0)}%`} k="shorter makespan" s="time to deliver every order, paired by trial" />
                <Headline v={`${(improvement('waitTicks') * 100).toFixed(0)}%`} k="less waiting" s="robot-seconds standing still" />
                <Headline v={`${summaries.find((s) => s.variant === 'anvaya')?.estops ?? 0} vs ${summaries.find((s) => s.variant === 'baseline')?.estops ?? 0}`} k="emergency stops" s="Level-1 safety-field interventions" />
                <Headline v={`${((summaries.find((s) => s.variant === 'anvaya')?.completionRate ?? 0) * 100).toFixed(0)}% vs ${((summaries.find((s) => s.variant === 'baseline')?.completionRate ?? 0) * 100).toFixed(0)}%`} k="runs fully delivered" s="all orders done within 700 s" />
              </div>
            )}

            {results.length > 0 && (
              <div className="card" style={{ marginTop: 18, overflowX: 'auto' }}>
                <div className="panel-title">Summary (mean ± 95% CI)</div>
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Planner</th>
                      <th>Trials</th>
                      <th>All delivered</th>
                      <th>Makespan (s)</th>
                      <th>Mean order time (s)</th>
                      <th>Waiting (robot-s)</th>
                      <th>Fairness</th>
                      <th>Emergency stops</th>
                      <th>Physical contacts</th>
                      <th>Long stalls</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summaries.map((s) => (
                      <tr key={s.variant}>
                        <td>
                          <span className="sw" style={{ background: VCOLOR[s.variant] }} /> {VARIANTS.find((v) => v.id === s.variant)?.title}
                        </td>
                        <td>{s.trials}</td>
                        <td>{(s.completionRate * 100).toFixed(0)}%</td>
                        <td>{s.makespan.mean.toFixed(0)} ± {s.makespan.ci95.toFixed(0)}</td>
                        <td>{s.meanCompletion.mean.toFixed(1)}</td>
                        <td>{s.waitTicks.mean.toFixed(0)} ± {s.waitTicks.ci95.toFixed(0)}</td>
                        <td>{s.fairness.mean.toFixed(2)}</td>
                        <td>{s.estops}</td>
                        <td>{s.collisions}</td>
                        <td>{s.deadlocks}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {results.length > 0 && (
              <div className="bench-charts">
                <FamilyChart results={results} variants={variants} metric="makespan" label="Makespan by family (s)" />
                <FamilyChart results={results} variants={variants} metric="waitTicks" label="Waiting by family (robot-s)" />
              </div>
            )}

            {results.length > 0 && (
              <div className="card" style={{ marginTop: 18 }}>
                <div className="panel-title">
                  Every trial
                  <span className="muted" style={{ fontSize: 12, marginLeft: 'auto' }}>click a row to replay that exact trial in the workbench</span>
                </div>
                <div className="trial-scroll scroll-y">
                  <table className="tbl small">
                    <thead>
                      <tr>
                        <th>Family</th>
                        <th>Seed</th>
                        <th>Planner</th>
                        <th>Delivered</th>
                        <th>Makespan</th>
                        <th>Waiting</th>
                        <th>E-stops</th>
                        <th>Contacts</th>
                        <th>Stalls</th>
                        <th>Agreement</th>
                        <th>Wall time</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...results]
                        .sort((a, b) => a.family.localeCompare(b.family) || a.seed - b.seed || a.variant.localeCompare(b.variant))
                        .map((r, k) => (
                          <tr key={k} className="clickable" onClick={() => nav(`/workbench?family=${r.family}&seed=${r.seed}&variant=${r.variant}`)}>
                            <td>{FAMILIES.find((f) => f.id === r.family)?.title}</td>
                            <td>{r.seed}</td>
                            <td>
                              <span className="sw" style={{ background: VCOLOR[r.variant] }} /> {r.variant}
                            </td>
                            <td>{r.tasksDone}/{r.tasksTotal}</td>
                            <td>{r.completed ? r.makespan : '>700'}</td>
                            <td>{r.waitTicks}</td>
                            <td>{r.estops}</td>
                            <td>{r.collisions}</td>
                            <td>{r.deadlocks}</td>
                            <td>{r.variant === 'baseline' ? '—' : `${(r.agreement * 100).toFixed(0)}%`}</td>
                            <td className="muted">{r.wallMs.toFixed(0)} ms</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {results.length === 0 && !running && (
              <div className="bench-empty">
                <div className="h3">Press run. The fleet does the rest.</div>
                <p className="muted">
                  Metric definitions and the statistics used are in the docs.{' '}
                  <a href="#" onClick={(e) => (e.preventDefault(), setDocs(true))} style={{ color: 'var(--lime)' }}>
                    Read docs →
                  </a>
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
      <DocsModal open={docs} onClose={() => setDocs(false)} initial="metrics" />
    </div>
  );
}

function Headline({ v, k, s }: { v: string; k: string; s: string }) {
  return (
    <div className="headline">
      <div className="display" style={{ fontSize: 44 }}>{v}</div>
      <div style={{ fontWeight: 600 }}>{k}</div>
      <div className="muted" style={{ fontSize: 12 }}>{s}</div>
    </div>
  );
}

function FamilyChart({ results, variants, metric, label }: { results: TrialResult[]; variants: string[]; metric: 'makespan' | 'waitTicks'; label: string }) {
  const fams = FAMILIES.filter((f) => results.some((r) => r.family === f.id));
  const data = fams.map((f) => ({
    f,
    vals: variants.map((v) => {
      const rs = results.filter((r) => r.family === f.id && r.variant === v);
      return rs.length ? rs.reduce((a, r) => a + r[metric], 0) / rs.length : 0;
    }),
  }));
  const max = Math.max(1, ...data.flatMap((d) => d.vals));
  return (
    <div className="card">
      <div className="panel-title">{label}</div>
      <div className="fchart">
        {data.map((d) => (
          <div key={d.f.id} className="fgroup">
            <div className="fbars">
              {d.vals.map((v, i) => (
                <div key={variants[i]} className="fbar" title={`${variants[i]}: ${v.toFixed(0)}`} style={{ height: `${(v / max) * 100}%`, background: VCOLOR[variants[i]] }}>
                  <span>{v.toFixed(0)}</span>
                </div>
              ))}
            </div>
            <div className="flabel">{d.f.title}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
