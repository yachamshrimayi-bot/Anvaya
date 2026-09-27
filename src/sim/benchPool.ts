import type { TrialResult } from '../engine/benchmark';

export interface Job {
  family: string;
  seed: number;
  variant: string;
}

/** Runs benchmark trials in parallel Web Workers. Returns a cancel function. */
export function runPool(jobs: Job[], onResult: (r: TrialResult) => void, onDone: () => void): () => void {
  const n = Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 4) - 1, jobs.length));
  const workers: Worker[] = [];
  let finished = 0;
  // interleave so each worker gets a mix of families (balanced run time)
  const buckets: Job[][] = Array.from({ length: n }, () => []);
  jobs.forEach((j, i) => buckets[i % n].push(j));
  for (let w = 0; w < n; w++) {
    const worker = new Worker(new URL('../workers/bench.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      if (e.data.type === 'result') onResult(e.data.r as TrialResult);
      else if (e.data.type === 'done') {
        worker.terminate();
        if (++finished === n) onDone();
      }
    };
    worker.postMessage({ jobs: buckets[w] });
    workers.push(worker);
  }
  return () => workers.forEach((w) => w.terminate());
}
