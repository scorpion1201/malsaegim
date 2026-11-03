// 화자 구분 평가 — 앱 파이프라인(runDiarization)을 node(onnxruntime-web, 1스레드)에서 평가셋에 돌려 범주별 숫자를 낸다.
// 사용:
//   node --import ./scripts/diarization/ts-loader.mjs scripts/diarization/eval.mjs --set $DATA/eval --label baseline --out report.json
//   ... eval.mjs --self-check                         지표 자체 확인
//   ... eval.mjs --compare base.json new.json         두 리포트 비교와 합격 기준
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { der, frameErrors, boundaryErrorMs, hypFrames, median } from './metrics.mjs';
import { readPcm16, readLabels } from './lib.mjs';

const { values: args } = parseArgs({
  options: {
    set: { type: 'string' },
    models: { type: 'string', default: `${process.env.DATA ?? '/Users/lucian/orca/data/malsaegim-diar'}/models` },
    'speech-model': { type: 'string' },
    label: { type: 'string', default: 'run' },
    out: { type: 'string' },
    limit: { type: 'string' },
    categories: { type: 'string' },
    'self-check': { type: 'boolean' },
    'chunk-check': { type: 'boolean' },
    compare: { type: 'boolean' },
  },
  allowPositionals: true,
});

const selfCheck = () => {
  const frames = 1000;
  const activity = [new Uint8Array(frames), new Uint8Array(frames)];
  for (let t = 100; t < 500; t += 1) activity[0][t] = 1;
  for (let t = 450; t < 900; t += 1) activity[1][t] = 1;
  const speech = Uint8Array.from({ length: frames }, (_, t) => activity[0][t] | activity[1][t]);
  // 화자 번호를 뒤바꾼 정답 가설 — 겹친 구간은 먼저 말한 사람
  const turns = [
    { startMs: 0, endMs: 5000, speaker: 7 },
    { startMs: 5000, endMs: 10000, speaker: 3 },
  ];
  const hyp = hypFrames(turns, speech, frames);
  const checks = {
    der_perfect: der(activity, hyp, 25),
    false_alarm: frameErrors(speech, speech).falseAlarm,
    miss: frameErrors(speech, speech).miss,
    count_exact: new Set(turns.map((turn) => turn.speaker)).size === 2 ? 1 : 0,
    boundary_ms: median(boundaryErrorMs([5.0], turns)),
  };
  const confused = hypFrames([{ startMs: 0, endMs: 10000, speaker: 1 }], speech, frames);
  checks.der_one_label = der(activity, confused, 0);
  console.log(JSON.stringify(checks));
  const ok = checks.der_perfect < 1e-9 && checks.false_alarm === 0 && checks.miss === 0 && checks.count_exact === 1 && checks.boundary_ms === 0 && Math.abs(checks.der_one_label - 400 / 850) < 1e-9;
  console.log(ok ? 'self-check ok' : 'self-check FAILED');
  process.exit(ok ? 0 : 1);
};

const loadSession = async (ort, path) => ort.InferenceSession.create(new Uint8Array(readFileSync(path)));

const evaluate = async () => {
  const { runDiarization, WINDOW_FRAMES } = await import('../../src/app/_lib/diarization/diarizePipeline.ts');
  const { MEL_BINS } = await import('../../src/app/_lib/diarization/fbank.ts');
  const ort = await import(join(args.models, 'ort.wasm.min.mjs'));
  ort.env.wasm.wasmPaths = `file://${args.models}/`;
  ort.env.wasm.numThreads = 1;
  const speaker = await loadSession(ort, join(args.models, 'speaker-campplus.onnx'));
  const speech = args['speech-model'] ? await loadSession(ort, args['speech-model']) : null;
  const deps = {
    embed: async (features) => (await speaker.run({ x: new ort.Tensor('float32', features, [1, WINDOW_FRAMES, MEL_BINS]) })).embedding.data,
    classify: speech
      ? async (logMel, frames) => (await speech.run({ logmel: new ort.Tensor('float32', logMel, [1, frames, MEL_BINS]) })).probs.data
      : null,
  };
  const wanted = args.categories ? new Set(args.categories.split(',')) : null;
  const categories = {};
  const started = Date.now();
  let audioSeconds = 0;
  for (const category of readdirSync(args.set).sort()) {
    if (wanted && !wanted.has(category)) continue;
    const dir = join(args.set, category);
    const scenes = readdirSync(dir).filter((name) => name.endsWith('.wav')).sort().slice(0, args.limit ? Number(args.limit) : undefined);
    const rows = [];
    for (const name of scenes) {
      const base = join(dir, name.slice(0, -4));
      const pcm = readPcm16(`${base}.wav`);
      const ref = readLabels(base);
      const result = await runDiarization(pcm, deps, () => {});
      const hyp = hypFrames(result.turns, result.speechFrames, ref.frames);
      const errors = frameErrors(ref.speech, result.speechFrames);
      const refSpeakers = ref.activity.filter((row) => row.some((value) => value)).length;
      const hypSpeakers = new Set(result.turns.map((turn) => turn.speaker)).size;
      rows.push({
        falseAlarm: errors.falseAlarm,
        miss: errors.miss,
        der: refSpeakers ? der(ref.activity, hyp, 25) : null,
        refSpeakers,
        hypSpeakers,
        boundary: ref.meta.interrupts.length ? median(boundaryErrorMs(ref.meta.interrupts, result.turns)) : null,
      });
      audioSeconds += pcm.length / 16000;
    }
    const mean = (key) => {
      const values = rows.map((row) => row[key]).filter((value) => value !== null && !Number.isNaN(value));
      return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    };
    const share = (test) => (rows.length ? rows.filter(test).length / rows.length : null);
    categories[category] = {
      scenes: rows.length,
      falseAlarm: mean('falseAlarm'),
      miss: mean('miss'),
      der: mean('der'),
      countExact: share((row) => row.refSpeakers === row.hypSpeakers || (row.refSpeakers === 0 && row.hypSpeakers <= 1)),
      countWithin1: share((row) => Math.abs(row.refSpeakers - row.hypSpeakers) <= 1),
      singleSplit: share((row) => row.refSpeakers === 1 && row.hypSpeakers > 1),
      boundaryMedianMs: rows.some((row) => row.boundary !== null) ? median(rows.map((row) => row.boundary).filter((value) => value !== null)) : null,
    };
    const c = categories[category];
    const fmt = (value, digits = 3) => (value === null ? '-' : value.toFixed(digits));
    console.log(`${category.padEnd(18)} n=${c.scenes} fa=${fmt(c.falseAlarm)} miss=${fmt(c.miss)} der=${fmt(c.der)} count=${fmt(c.countExact, 2)} ±1=${fmt(c.countWithin1, 2)} split1=${fmt(c.singleSplit, 2)} boundary_ms=${fmt(c.boundaryMedianMs, 0)}`);
  }
  const report = { label: args.label, realtimeFactor: (Date.now() - started) / 1000 / Math.max(1, audioSeconds), categories };
  if (args.out) writeFileSync(args.out, JSON.stringify(report, null, 2));
  console.log(`label=${args.label} rtf=${report.realtimeFactor.toFixed(4)}`);
};

const compare = () => {
  const [basePath, nextPath] = process.argv.slice(process.argv.indexOf('--compare') + 1);
  const base = JSON.parse(readFileSync(basePath, 'utf8')).categories;
  const next = JSON.parse(readFileSync(nextPath, 'utf8')).categories;
  const failures = [];
  const noise = ['empty-room', 'fan', 'keyboard', 'music'];
  for (const [category, n] of Object.entries(next)) {
    const b = base[category] ?? {};
    const notes = [];
    if (noise.includes(category) && n.falseAlarm > 0.02) notes.push(`fa ${n.falseAlarm.toFixed(3)} > 0.02`);
    if (category === 'far' && n.miss > 0.05) notes.push(`miss ${n.miss.toFixed(3)} > 0.05`);
    if (['one-pause', 'short-tail', 'backchannel'].includes(category) && n.singleSplit > 0.02) notes.push(`split1 ${n.singleSplit.toFixed(2)} > 0.02`);
    if (['n2', 'n3', 'n4'].includes(category) && n.countExact < 0.8) notes.push(`count ${n.countExact.toFixed(2)} < 0.8`);
    if (['n5', 'n6'].includes(category) && n.countWithin1 < 0.8) notes.push(`±1 ${n.countWithin1.toFixed(2)} < 0.8`);
    if (n.der !== null && b.der !== null && b.der !== undefined && n.der >= b.der && category !== 'tv') notes.push(`der ${n.der.toFixed(3)} >= base ${b.der.toFixed(3)}`);
    if (category.startsWith('interrupt') && n.boundaryMedianMs > 500) notes.push(`boundary ${n.boundaryMedianMs.toFixed(0)} > 500`);
    console.log(`${category.padEnd(18)} der ${b.der?.toFixed(3) ?? '-'} → ${n.der?.toFixed(3) ?? '-'}  fa ${b.falseAlarm?.toFixed(3) ?? '-'} → ${n.falseAlarm?.toFixed(3) ?? '-'}  ${notes.length ? 'FAIL ' + notes.join('; ') : 'ok'}`);
    if (notes.length && category !== 'tv') failures.push(category);
  }
  console.log(failures.length ? `FAILED: ${failures.join(', ')}` : 'all criteria met');
  process.exit(failures.length ? 1 : 0);
};

// 조각 추론(10초 + 앞뒤 1초)의 경계 민감도 — 모델은 8초 구간을 빈 상태에서 시작하도록 학습해, 비교 기준은 한 번에 넣은 추론이 아니라
// 조각 격자를 5초 옮긴 추론이다 (옮긴 쪽 처음 2초, 녹음 끝 25프레임 제외). 출력 프레임 수도 확인한다 (길이 20.0초, 20.5초, 9초)
const chunkCheck = async () => {
  const { classifyChunks, logMelFrames } = await import('../../src/app/_lib/diarization/speechClassifier.ts');
  const ort = await import(join(args.models, 'ort.wasm.min.mjs'));
  ort.env.wasm.wasmPaths = `file://${args.models}/`;
  ort.env.wasm.numThreads = 1;
  const session = await loadSession(ort, args['speech-model']);
  const run = async (logMel, frames) => (await session.run({ logmel: new ort.Tensor('float32', logMel, [1, frames, 80]) })).probs.data;
  let ok = true;
  const source = readPcm16(join(args.set, 'n2', '000.wav'));
  for (const samples of [320_000, 328_000, 144_000]) {
    const result = await classifyChunks(source.subarray(0, samples), run);
    const expected = Math.floor((samples - 400) / 160) + 1;
    ok &&= result.speech.length === expected && result.speech.length === logMelFrames(samples);
    console.log(`seconds=${(samples / 16000).toFixed(1)} frames=${result.speech.length}/${expected}`);
  }
  for (const name of ['n2/000', 'n4/001', 'interrupt-overlap/002', 'far/003']) {
    const pcm = readPcm16(join(args.set, `${name}.wav`));
    const base = await classifyChunks(pcm, run);
    const shifted = await classifyChunks(pcm.subarray(80_000), run);
    let worst = 0;
    for (let t = 200; t < shifted.speech.length - 25; t += 1) {
      worst = Math.max(worst, Math.abs(shifted.speech[t] - base.speech[t + 500]), Math.abs(shifted.overlap[t] - base.overlap[t + 500]));
    }
    const pass = worst < 0.02;
    ok &&= pass;
    console.log(`${name} seconds=${(pcm.length / 16000).toFixed(1)} shifted_grid_max_diff=${worst.toFixed(4)} ${pass ? 'ok' : 'FAIL'}`);
  }
  process.exit(ok ? 0 : 1);
};

if (args['self-check']) selfCheck();
else if (args['chunk-check']) await chunkCheck();
else if (args.compare) compare();
else await evaluate();