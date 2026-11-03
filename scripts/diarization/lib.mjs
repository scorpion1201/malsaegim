// 평가 도구 공용 — WAV 와 장면 라벨 읽기
import { readFileSync } from 'node:fs';

/** 16 kHz 모노 PCM16 WAV 의 data 청크 */
export const readPcm16 = (path) => {
  const bytes = readFileSync(path);
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (id === 'data') return new Int16Array(bytes.buffer.slice(bytes.byteOffset + offset + 8, bytes.byteOffset + offset + 8 + size));
    offset += 8 + size + (size % 2);
  }
  throw new Error(`data 청크가 없습니다: ${path}`);
};

/** build-eval.py 가 쓴 라벨: <base>.json (meta) + <base>.labels.bin ([speech T][overlap T][activity K×T], uint8) */
export const readLabels = (base) => {
  const meta = JSON.parse(readFileSync(`${base}.json`, 'utf8'));
  const raw = readFileSync(`${base}.labels.bin`);
  const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.length);
  const frames = meta.frames;
  const activity = Array.from({ length: meta.activityRows }, (_, k) => bytes.subarray((2 + k) * frames, (3 + k) * frames));
  return { meta, frames, speech: bytes.subarray(0, frames), overlap: bytes.subarray(frames, 2 * frames), activity };
};