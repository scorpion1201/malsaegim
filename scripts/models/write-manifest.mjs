// public/models 를 만든다: <out>/manifest.json + <out>/<version>/<파일들>.
// 버전은 파일 내용 해시라 내용이 같으면 URL 도 같고(immutable 캐시), 바뀌면 브라우저가 새 버전만 받는다.
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const FILES = [
  { id: 'whisper-js', name: 'malsaegim-engine.js', engine: 'whisper' },
  { id: 'whisper-wasm', name: 'malsaegim-engine.wasm', engine: 'whisper' },
  { id: 'whisper-model', name: 'whisper-ko-q8_0.bin', engine: 'whisper' },
  { id: 'sherpa-js', name: 'malsaegim-engine-stream.js', engine: 'sherpa' },
  { id: 'sherpa-wasm', name: 'malsaegim-engine-stream.wasm', engine: 'sherpa' },
  { id: 'sherpa-encoder', name: 'sherpa-encoder.onnx', engine: 'sherpa' },
  { id: 'sherpa-decoder', name: 'sherpa-decoder.onnx', engine: 'sherpa' },
  { id: 'sherpa-joiner', name: 'sherpa-joiner.onnx', engine: 'sherpa' },
  { id: 'sherpa-tokens', name: 'sherpa-tokens.txt', engine: 'sherpa' },
];

const [src, out] = process.argv.slice(2);
if (!src || !out) {
  console.error('usage: node write-manifest.mjs <src-dir> <out-dir>');
  process.exit(1);
}

const sha256 = async (path) => createHash('sha256').update(await readFile(path)).digest('hex');

const entries = [];
for (const file of FILES) {
  const path = join(src, file.name);
  const { size } = await stat(path);
  entries.push({ ...file, bytes: size, sha256: await sha256(path) });
}
const version = createHash('sha256').update(entries.map((entry) => entry.sha256).join('\n')).digest('hex').slice(0, 12);

await rm(out, { recursive: true, force: true });
const dir = join(out, version);
await mkdir(dir, { recursive: true });
for (const entry of entries) await copyFile(join(src, entry.name), join(dir, entry.name));

const manifest = {
  version,
  totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
  files: entries.map((entry) => ({
    id: entry.id,
    name: entry.name,
    url: `/models/${version}/${entry.name}`,
    bytes: entry.bytes,
    sha256: entry.sha256,
    engine: entry.engine,
  })),
};
await writeFile(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`manifest ${version}: ${entries.length} files, ${Math.round(manifest.totalBytes / 1048576)} MB`);