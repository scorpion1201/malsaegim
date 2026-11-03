// 묶기 방식과 값 고르기 — val 장면의 창 임베딩을 한 번 만들어 두고, 평균 연결(ahc)과 스펙트럴(nme) 값을 좌표 탐색으로 비교한다.
// 선택 규칙: 1인 범주(one-pause, short-tail, backchannel) 분할률 ≤ 2% 인 조합 중 범주 평균 DER 최소. 동률이면 ahc.
// 사용: node --import ./scripts/diarization/ts-loader.mjs scripts/diarization/tune-cluster.mjs --set $DATA/val [--speech-model m.onnx]
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { readLabels, readPcm16 } from './lib.mjs';
import { der, hypFrames } from './metrics.mjs';

const { values: args } = parseArgs({
  options: {
    set: { type: 'string' },
    models: { type: 'string', default: `${process.env.DATA ?? '/Users/lucian/orca/data/malsaegim-diar'}/models` },
    'speech-model': { type: 'string' },
  },
});

const { embedWindows, labelWindows, WINDOW_FRAMES } = await import('../../src/app/_lib/diarization/diarizePipeline.ts');
const { CLUSTER_PARAMS } = await import('../../src/app/_lib/diarization/clusterSpeakers.ts');
const ort = await import(join(args.models, 'ort.wasm.min.mjs'));
ort.env.wasm.wasmPaths = `file://${args.models}/`;
ort.env.wasm.numThreads = 1;
const speaker = await ort.InferenceSession.create(new Uint8Array(readFileSync(join(args.models, 'speaker-campplus.onnx'))));
const speech = args['speech-model'] ? await ort.InferenceSession.create(new Uint8Array(readFileSync(args['speech-model']))) : null;
const deps = {
  embed: async (features) => (await speaker.run({ x: new ort.Tensor('float32', features, [1, WINDOW_FRAMES, 80]) })).embedding.data,
  classify: speech ? async (logMel, frames) => (await speech.run({ logmel: new ort.Tensor('float32', logMel, [1, frames, 80]) })).probs.data : null,
};
console.debug = () => {};

const SINGLE = new Set(['one-pause', 'short-tail', 'backchannel']);
const scenes = [];
for (const category of readdirSync(args.set).sort()) {
  for (const name of readdirSync(join(args.set, category)).filter((file) => file.endsWith('.wav'))) {
    const base = join(args.set, category, name.slice(0, -4));
    const ref = readLabels(base);
    if (!ref.activity.some((row) => row.some((value) => value))) continue;
    scenes.push({ category, ref, windows: await embedWindows(readPcm16(`${base}.wav`), deps, () => {}) });
  }
}
console.log(`scenes=${scenes.length}`);

const evaluate = (params) => {
  const per = {};
  let single = 0;
  let singleSplit = 0;
  for (const { category, ref, windows } of scenes) {
    const result = labelWindows(windows, params);
    const hyp = hypFrames(result.turns, result.speechFrames, ref.frames);
    (per[category] ??= []).push(der(ref.activity, hyp, 25) ?? 0);
    if (SINGLE.has(category)) {
      single += 1;
      if (new Set(result.turns.map((turn) => turn.speaker)).size > 1) singleSplit += 1;
    }
  }
  const means = Object.values(per).map((values) => values.reduce((sum, value) => sum + value, 0) / values.length);
  return { der: means.reduce((sum, value) => sum + value, 0) / means.length, split: single ? singleSplit / single : 0 };
};

const better = (a, b) => {
  if (!b) return true;
  const aOk = a.score.split <= 0.02;
  const bOk = b.score.split <= 0.02;
  if (aOk !== bOk) return aOk;
  if (!aOk) return a.score.split < b.score.split || (a.score.split === b.score.split && a.score.der < b.score.der);
  return a.score.der < b.score.der - 1e-9 || (Math.abs(a.score.der - b.score.der) <= 1e-9 && a.params.method === 'ahc' && b.params.method !== 'ahc');
};

const range = (from, to, step) => Array.from({ length: Math.round((to - from) / step) + 1 }, (_, i) => Math.round((from + i * step) * 1000) / 1000);
const GRID = {
  ahc: {
    mergeThreshold: range(0.1, 0.4, 0.02),
    balancedThreshold: range(0.2, 0.5, 0.05),
    balancedShare: [0.1, 0.2, 0.3],
    minClusterWindows: [2, 3, 5],
    centroidMergeSimilarity: [0.5, 0.6, 0.7],
    shortSplitSimilarity: [...range(0, 0.6, 0.05), 1],
  },
  nme: {
    oneSpeakerSimilarity: [...range(0.3, 0.8, 0.05), 1],
    minClusterWindows: [2, 3, 5],
    centroidMergeSimilarity: [0.5, 0.6, 0.7],
    shortSplitSimilarity: [...range(0, 0.6, 0.05), 1],
  },
};

let best = null;
for (const method of ['ahc', 'nme']) {
  let current = { params: { ...CLUSTER_PARAMS, method }, score: null };
  current.score = evaluate(current.params);
  for (let pass = 0; pass < 2; pass += 1) {
    for (const [key, values] of Object.entries(GRID[method])) {
      for (const value of values) {
        const candidate = { params: { ...current.params, [key]: value }, score: null };
        candidate.score = evaluate(candidate.params);
        if (better(candidate, current)) current = candidate;
      }
    }
    console.log(`${method} pass ${pass + 1}: der=${current.score.der.toFixed(4)} split1=${current.score.split.toFixed(3)} ${JSON.stringify(current.params)}`);
  }
  if (better(current, best)) best = current;
}
console.log(`chosen der=${best.score.der.toFixed(4)} split1=${best.score.split.toFixed(3)}`);
console.log(JSON.stringify(best.params));