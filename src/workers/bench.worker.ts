/// <reference lib="webworker" />
import { runTrial } from '../engine/benchmark';

// Each worker runs whole trials: the same engine code as the live twin and the CLI.
self.onmessage = (e: MessageEvent<{ jobs: { family: string; seed: number; variant: string }[] }>) => {
  for (const j of e.data.jobs) {
    const r = runTrial(j.family, j.seed, j.variant);
    (self as unknown as Worker).postMessage({ type: 'result', r });
  }
  (self as unknown as Worker).postMessage({ type: 'done' });
};
