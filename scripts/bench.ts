/**
 * Headless, reproducible benchmark — the same code the browser runs in its Web Worker.
 *   npm run bench                 # 5 families × 10 seeds, ANVAYA vs baseline (+ ablations with --ablations)
 *   npm run bench -- --seeds 20   # more seeds
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { FAMILIES, VARIANTS, pairedImprovement, runTrial, summarize, type TrialResult } from '../src/engine/benchmark';

const args = process.argv.slice(2);
const seedsArg = args.indexOf('--seeds');
const seeds = seedsArg >= 0 ? Number(args[seedsArg + 1]) : 10;
const variants = args.includes('--ablations') ? VARIANTS.map((v) => v.id) : ['anvaya', 'baseline'];

const results: TrialResult[] = [];
const total = FAMILIES.length * seeds * variants.length;
let k = 0;
const t0 = Date.now();
for (const f of FAMILIES) {
  for (let s = 1; s <= seeds; s++) {
    for (const v of variants) {
      results.push(runTrial(f.id, s, v));
      k++;
      if (k % 10 === 0 || k === total) process.stdout.write(`\r  ${k}/${total} trials  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    }
  }
}
process.stdout.write('\n\n');

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
console.log('| Variant | Trials | All orders done | Makespan (ticks) | Mean order time | Waiting ticks | Near-misses (Level-1 stops) | Physical contacts | Long stalls |');
console.log('|---|---|---|---|---|---|---|---|---|');
for (const v of variants) {
  const s = summarize(results, v);
  console.log(`| ${VARIANTS.find((x) => x.id === v)!.title} | ${s.trials} | ${pct(s.completionRate)} | ${s.makespan.mean.toFixed(0)} ± ${s.makespan.ci95.toFixed(0)} | ${s.meanCompletion.mean.toFixed(1)} | ${s.waitTicks.mean.toFixed(0)} | ${s.estops} | ${s.collisions} | ${s.deadlocks} |`);
}
console.log('');
console.log(`Makespan reduction vs baseline:        ${pct(pairedImprovement(results, 'anvaya', 'baseline', 'makespan'))}`);
console.log(`Waiting-time reduction vs baseline:    ${pct(pairedImprovement(results, 'anvaya', 'baseline', 'waitTicks'))}`);
console.log(`Mean order-time reduction vs baseline: ${pct(pairedImprovement(results, 'anvaya', 'baseline', 'meanCompletion'))}`);

mkdirSync('results', { recursive: true });
const file = `results/benchmark-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
writeFileSync(file, JSON.stringify({ generatedAt: new Date().toISOString(), seeds, variants, results }, null, 2));
console.log(`\nRaw per-trial results: ${file}`);
