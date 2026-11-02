// public/models 를 만든다: <out>/manifest.json + 파일 묶음별 내용 해시 디렉터리.
//  - 런타임(엔진 js+wasm, CPU·WebGPU): /models/runtime/<hash>/ — emcc 산출물은 서로의 이름을 참조해 같은 디렉터리에 둔다
//  - 모델: /models/<model-id>/<sha256 앞 12자리>/<파일>
// URL 이 내용 해시라 내용이 같으면 URL 도 같고(immutable 캐시), 한 묶음이 바뀌어도 다른 묶음은 다시 받지 않는다.
// 엔진(engine)과 모델(models)을 나눠 두어, 기기마다 고른 모델 하나만 받고 실시간·파일 전사가 그 파일을 함께 쓴다.
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// CPU 런타임(SIMD + pthread)과 WebGPU 런타임(ASYNCIFY). 앱은 WebGPU 를 먼저 시도하고 안 되면 CPU 로 돌린다
const RUNTIME = [
  { id: 'engine-js', name: 'malsaegim-engine.js' },
  { id: 'engine-wasm', name: 'malsaegim-engine.wasm' },
  { id: 'engine-webgpu-js', name: 'malsaegim-engine-webgpu.js' },
  { id: 'engine-webgpu-wasm', name: 'malsaegim-engine-webgpu.wasm' },
];

// 화자 구분: onnxruntime-web 런타임과 임베딩 모델 — 런타임이 wasm 을 이름으로 찾으므로 한 디렉터리에 둔다
const SPEAKER = [
  { id: 'ort-js', name: 'ort.wasm.min.mjs' },
  { id: 'ort-wasm-js', name: 'ort-wasm-simd-threaded.mjs' },
  { id: 'ort-wasm', name: 'ort-wasm-simd-threaded.wasm' },
  { id: 'speaker-model', name: 'speaker-campplus.onnx' },
];

// tier: full = PC·고사양 기기 기본, lite = 메모리가 부족한 기기 기본 (src/app/_lib/engine/deviceProfile.ts)
// memoryMB: 모델을 올린 뒤 wasm 힙 실측치(Chromium, whisper.cpp v1.9.5) — 설정 화면 안내용
const MODELS = [
  {
    id: 'large-v3-turbo-q8_0',
    label: 'Whisper large-v3-turbo',
    quant: 'q8_0',
    tier: 'full',
    memoryMB: 1667,
    name: 'ggml-large-v3-turbo-q8_0.bin',
  },
  {
    id: 'small-q8_0',
    label: 'Whisper small',
    quant: 'q8_0',
    tier: 'lite',
    memoryMB: 1016,
    name: 'ggml-small-q8_0.bin',
  },
];

const [src, out] = process.argv.slice(2);
if (!src || !out) {
  console.error('usage: node write-manifest.mjs <src-dir> <out-dir>');
  process.exit(1);
}

const sha256 = async (path) => createHash('sha256').update(await readFile(path)).digest('hex');
const describe = async (name) => {
  const path = join(src, name);
  const { size } = await stat(path);
  return { name, bytes: size, sha256: await sha256(path) };
};

await rm(out, { recursive: true, force: true });
const place = async (dir, file) => {
  await mkdir(join(out, dir), { recursive: true });
  await copyFile(join(src, file.name), join(out, dir, file.name));
  return `/models/${dir}/${file.name}`;
};

const runtimeFiles = [];
for (const entry of RUNTIME) runtimeFiles.push({ id: entry.id, ...(await describe(entry.name)) });
const runtimeVersion = createHash('sha256')
  .update(runtimeFiles.map((file) => file.sha256).join('\n'))
  .digest('hex')
  .slice(0, 12);
for (const file of runtimeFiles) file.url = await place(`runtime/${runtimeVersion}`, file);

const models = [];
for (const model of MODELS) {
  const { name, ...info } = model;
  const file = { id: 'model', ...(await describe(name)) };
  file.url = await place(`${model.id}/${file.sha256.slice(0, 12)}`, file);
  models.push({ ...info, engine: 'whisper', file });
}

const speakerFiles = [];
for (const entry of SPEAKER) speakerFiles.push({ id: entry.id, ...(await describe(entry.name)) });
const speakerVersion = createHash('sha256')
  .update(speakerFiles.map((file) => file.sha256).join('\n'))
  .digest('hex')
  .slice(0, 12);
for (const file of speakerFiles) file.url = await place(`speaker/${speakerVersion}`, file);

const manifest = { schema: 2, runtime: { version: runtimeVersion, files: runtimeFiles }, models, speaker: { version: speakerVersion, files: speakerFiles } };
await writeFile(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
for (const model of models) {
  console.log(`${model.id}: ${model.file.url} (${Math.round(model.file.bytes / 1048576)} MB)`);
}
console.log(`runtime ${runtimeVersion}: ${runtimeFiles.map((file) => file.name).join(', ')}`);
console.log(`speaker ${speakerVersion}: ${speakerFiles.map((file) => file.name).join(', ')}`);