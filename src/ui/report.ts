import { FAMILIES, MAX_TICKS, pairedImprovement, summarize, VARIANTS, type TrialResult } from '../engine/benchmark';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const COLORS: Record<string, string> = { anvaya: '#4d7c0f', baseline: '#9ca3af', 'no-fleetcost': '#0f766e', 'no-fairness': '#0369a1', 'short-horizon': '#c2410c' };

function barChart(title: string, results: TrialResult[], variants: string[], metric: 'makespan' | 'waitTicks'): string {
  const fams = FAMILIES.filter((f) => results.some((r) => r.family === f.id));
  const data = fams.map((f) => variants.map((v) => {
    const rs = results.filter((r) => r.family === f.id && r.variant === v);
    return rs.length ? rs.reduce((a, r) => a + r[metric], 0) / rs.length : 0;
  }));
  const max = Math.max(1, ...data.flat());
  const W = 680;
  const H = 210;
  const gw = W / Math.max(1, fams.length);
  const bw = Math.min(26, (gw - 24) / Math.max(1, variants.length));
  let bars = '';
  fams.forEach((f, i) => {
    variants.forEach((v, j) => {
      const val = data[i][j];
      const h = (val / max) * (H - 50);
      const x = i * gw + (gw - bw * variants.length) / 2 + j * bw;
      bars += `<rect x="${x.toFixed(1)}" y="${(H - 30 - h).toFixed(1)}" width="${(bw - 3).toFixed(1)}" height="${h.toFixed(1)}" rx="3" fill="${COLORS[v] ?? '#666'}"/>`;
      bars += `<text x="${(x + (bw - 3) / 2).toFixed(1)}" y="${(H - 34 - h).toFixed(1)}" font-size="8" text-anchor="middle" fill="#333">${val.toFixed(0)}</text>`;
    });
    bars += `<text x="${(i * gw + gw / 2).toFixed(1)}" y="${H - 12}" font-size="9.5" text-anchor="middle" fill="#444">${esc(f.title)}</text>`;
  });
  return `<figure><figcaption>${esc(title)}</figcaption><svg viewBox="0 0 ${W} ${H}" width="100%">${bars}<line x1="0" y1="${H - 30}" x2="${W}" y2="${H - 30}" stroke="#ccc"/></svg></figure>`;
}

export function exportPdfReport(results: TrialResult[], variants: string[], seeds: number, elapsedS: number): void {
  const date = new Date();
  const sums = variants.map((v) => summarize(results, v));
  const title = (v: string) => VARIANTS.find((x) => x.id === v)?.title ?? v;
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const hasPair = variants.includes('anvaya') && variants.includes('baseline');
  const a = sums.find((s) => s.variant === 'anvaya');
  const b = sums.find((s) => s.variant === 'baseline');
  const fams = FAMILIES.filter((f) => results.some((r) => r.family === f.id));

  const headline = hasPair && a && b
    ? `<div class="kpis">
        <div><b>${pct(pairedImprovement(results, 'anvaya', 'baseline', 'makespan'))}</b><span>shorter makespan (paired by trial)</span></div>
        <div><b>${pct(pairedImprovement(results, 'anvaya', 'baseline', 'waitTicks'))}</b><span>less robot waiting</span></div>
        <div><b>${a.estops} vs ${b.estops}</b><span>emergency stops needed</span></div>
        <div><b>${(a.completionRate * 100).toFixed(0)}% vs ${(b.completionRate * 100).toFixed(0)}%</b><span>trials with every order delivered</span></div>
        <div><b>${a.collisions + b.collisions}</b><span>physical contacts (all planners)</span></div>
      </div>`
    : '';

  const summaryRows = sums.map((s) => `<tr><td><i style="background:${COLORS[s.variant] ?? '#666'}"></i>${esc(title(s.variant))}</td><td>${s.trials}</td><td>${(s.completionRate * 100).toFixed(0)}%</td><td>${s.makespan.mean.toFixed(0)} ± ${s.makespan.ci95.toFixed(0)}</td><td>${s.meanCompletion.mean.toFixed(1)}</td><td>${s.waitTicks.mean.toFixed(0)} ± ${s.waitTicks.ci95.toFixed(0)}</td><td>${s.fairness.mean.toFixed(2)}</td><td>${s.estops}</td><td>${s.collisions}</td><td>${s.deadlocks}</td></tr>`).join('');

  const trialRows = [...results]
    .sort((x, y) => x.family.localeCompare(y.family) || x.seed - y.seed || x.variant.localeCompare(y.variant))
    .map((r) => `<tr><td>${esc(FAMILIES.find((f) => f.id === r.family)?.title ?? r.family)}</td><td>${r.seed}</td><td>${esc(r.variant)}</td><td>${r.tasksDone}/${r.tasksTotal}</td><td>${r.completed ? r.makespan : `>${MAX_TICKS}`}</td><td>${r.waitTicks}</td><td>${r.estops}</td><td>${r.collisions}</td><td>${r.deadlocks}</td><td>${r.variant === 'baseline' ? '—' : pct(r.agreement)}</td></tr>`)
    .join('');

  const ablation = variants.filter((v) => v !== 'anvaya' && v !== 'baseline');
  const ablationText = ablation.length && a
    ? `<h2>Ablation study</h2><p>Each variant removes one ANVAYA component on the identical trials (solution document §73). A positive number means the component helps.</p><table><thead><tr><th>Component removed</th><th>Makespan impact</th><th>Waiting impact</th><th>Trials fully delivered</th></tr></thead><tbody>${ablation
        .map((v) => {
          const s = sums.find((x) => x.variant === v)!;
          return `<tr><td>${esc(title(v).replace('ANVAYA − ', ''))}</td><td>${pct(pairedImprovement(results, 'anvaya', v, 'makespan'))} worse without it</td><td>${pct(pairedImprovement(results, 'anvaya', v, 'waitTicks'))} worse without it</td><td>${(s.completionRate * 100).toFixed(0)}% (vs ${(a.completionRate * 100).toFixed(0)}% full)</td></tr>`;
        })
        .join('')}</tbody></table>`
    : '';

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>ANVAYA benchmark report — ${date.toISOString().slice(0, 10)}</title>
<style>
  @page { size: A4; margin: 16mm 14mm; }
  * { box-sizing: border-box; }
  body { font: 10.5pt/1.5 -apple-system, "Segoe UI", Inter, Roboto, Arial, sans-serif; color: #1a1a1a; margin: 0; }
  header { display:flex; justify-content:space-between; align-items:flex-end; border-bottom: 2px solid #1a1a1a; padding-bottom: 8px; margin-bottom: 14px; }
  h1 { font-size: 22pt; margin: 0; letter-spacing: -0.02em; }
  h1 small { display:block; font-size: 10pt; font-weight: 500; color:#555; letter-spacing: 0; margin-top: 4px; }
  .badge { background:#d9f779; color:#1a1a1a; font-weight:700; font-size:9pt; padding:3px 9px; border-radius: 99px; }
  h2 { font-size: 13pt; margin: 20px 0 6px; padding-top: 4px; border-top: 1px solid #e5e5e5; }
  p { margin: 4px 0 8px; color:#333; }
  .kpis { display:grid; grid-template-columns: repeat(5, 1fr); gap: 8px; margin: 10px 0 4px; }
  .kpis div { border: 1px solid #ddd; border-radius: 10px; padding: 8px 10px; background: linear-gradient(160deg,#f7fde6,#fff); }
  .kpis b { display:block; font-size: 15pt; letter-spacing:-0.02em; }
  .kpis span { font-size: 8.5pt; color:#555; }
  table { width:100%; border-collapse: collapse; font-size: 9pt; margin: 6px 0; }
  th, td { text-align:left; padding: 5px 6px; border-bottom: 1px solid #eee; }
  th { font-weight:600; color:#555; background:#fafafa; }
  td i { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:6px; }
  figure { margin: 8px 0; break-inside: avoid; }
  figcaption { font-weight:600; font-size: 10pt; margin-bottom: 2px; }
  .appendix table { font-size: 8pt; }
  .appendix td, .appendix th { padding: 3px 5px; }
  ul { margin: 4px 0 8px 18px; padding: 0; }
  li { margin: 2px 0; }
  code { font: 9pt ui-monospace, Menlo, monospace; background:#f3f3f3; padding: 1px 4px; border-radius: 4px; }
  .foot { margin-top: 18px; font-size: 8.5pt; color:#777; border-top:1px solid #e5e5e5; padding-top: 6px; }
  .legend span { margin-right: 14px; font-size: 9pt; }
  .legend i { display:inline-block; width:9px; height:9px; border-radius:2px; margin-right:5px; vertical-align: -1px; }
</style></head><body>
<header><h1>ANVAYA — benchmark report<small>Predictive, decentralized multi-AMR fleet coordination · SIH 2026 · PS 26123</small></h1><span class="badge">${date.toLocaleString()}</span></header>

<h2 style="border:none;margin-top:0">Summary</h2>
<p>${results.length} trials (${fams.length} families × ${seeds} seeds × ${variants.length} planner variants) were run in ${elapsedS.toFixed(1)} s on this machine by the same engine that drives the live digital twin. Every planner faced the <b>identical</b> warehouse, fleet, order list and fault timeline for each seed.</p>
${headline}

<h2>Results (mean ± 95% confidence interval)</h2>
<table><thead><tr><th>Planner</th><th>Trials</th><th>All delivered</th><th>Makespan (s)</th><th>Mean order time (s)</th><th>Waiting (robot-s)</th><th>Fairness (Jain)</th><th>Emergency stops</th><th>Physical contacts</th><th>Long stalls</th></tr></thead><tbody>${summaryRows}</tbody></table>
<div class="legend">${variants.map((v) => `<span><i style="background:${COLORS[v] ?? '#666'}"></i>${esc(title(v))}</span>`).join('')}</div>
${barChart('Makespan by trial family (s, lower is better)', results, variants, 'makespan')}
${barChart('Robot waiting by trial family (robot-seconds, lower is better)', results, variants, 'waitTicks')}
${ablationText}

<h2>Method</h2>
<ul>
  <li><b>World:</b> 4-connected grid warehouse, 1 cell = 1.2 m, 1 tick = 1 s (robots cruise at 1.2 m/s). Every robot has an onboard Level-1 safety field; the world checks for physical contact after every tick.</li>
  <li><b>ANVAYA:</b> every robot runs the same decentralized loop — Ed25519-signed P2P heartbeats (observe), 16 s space-time prediction and conflict graph (predict), Space-Time A* reservations with headway and K-tick binding commitments (reserve), fleet-wide cost + fairness precedence (decide), lidar right-of-way gate (execute), plan-vs-reality trust with isolation below 0.40 (verify). Tasks are allocated by a P2P auction.</li>
  <li><b>Baseline (stop-and-wait):</b> independent shortest paths, reacts only to the next cell (lower id goes first), detours after waiting 6 s; same auction and mission logic.</li>
  <li><b>Families:</b> ${fams.map((f) => `${esc(f.title)} (${esc(f.detail)})`).join('; ')}.</li>
  <li><b>Metrics:</b> makespan = ticks until every order is delivered (capped at ${MAX_TICKS}); waiting = robot-seconds standing still with somewhere to go; emergency stops = Level-1 safety-field interventions (near-misses); long stalls = a robot with a goal making no progress for 30 s; fairness = Jain's index of per-robot waiting.</li>
</ul>

<h2>Reproduce</h2>
<p>All results are deterministic functions of their seeds. In the repository run <code>npm run bench</code> (add <code>--ablations</code> or <code>--seeds 20</code>), or open the Benchmark lab in the app and press Run. Any trial can be replayed in the Workbench from the per-trial table.</p>

<div class="appendix"><h2>Appendix — every trial</h2>
<table><thead><tr><th>Family</th><th>Seed</th><th>Planner</th><th>Delivered</th><th>Makespan</th><th>Waiting</th><th>E-stops</th><th>Contacts</th><th>Stalls</th><th>Agreement</th></tr></thead><tbody>${trialRows}</tbody></table></div>

<div class="foot">Generated by the ANVAYA fleet workbench · results computed locally, nothing precomputed · ${navigator.hardwareConcurrency || '?'} CPU threads.</div>
</body></html>`;

  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  document.body.appendChild(frame);
  const doc = frame.contentDocument!;
  doc.open();
  doc.write(html);
  doc.close();
  const go = () => {
    const w = frame.contentWindow!;
    w.focus();
    w.print();
    setTimeout(() => frame.remove(), 1500);
  };
  if (doc.readyState === 'complete') setTimeout(go, 150);
  else frame.onload = () => setTimeout(go, 150);
}
