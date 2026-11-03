// 16 kHz 모노 PCM16 WAV → 앱 fbank 결과를 float32 raw 로 저장한다 (features.py --compare 와 맞춰 보는 용도).
// 사용: node --import ./scripts/diarization/ts-loader.mjs scripts/diarization/dump-fbank.mjs in.wav out.f32 [--window]
//   기본: 녹음 전체 log-mel (frames × 80, 평균 빼기 없음)
//   --window: 화자 임베딩 창(150 프레임, 75 간격)마다 createFbank 결과를 이어 붙인다
import { writeFileSync } from 'node:fs';
import { HOP_SAMPLES, createFbank, createLogMel } from '../../src/app/_lib/diarization/fbank.ts';
import { readPcm16 } from './lib.mjs';

const WINDOW_FRAMES = 150;
const STEP_FRAMES = 75;
const FRAME_SAMPLES = 400;

const [input, output, mode] = process.argv.slice(2);
const pcm = readPcm16(input);
let out;
if (mode === '--window') {
  const fbank = createFbank(WINDOW_FRAMES);
  const windowSamples = FRAME_SAMPLES + (WINDOW_FRAMES - 1) * HOP_SAMPLES;
  const parts = [];
  for (let start = 0; start + windowSamples <= pcm.length; start += STEP_FRAMES * HOP_SAMPLES) parts.push(fbank(pcm, start));
  out = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
} else {
  const frames = Math.floor((pcm.length - FRAME_SAMPLES) / HOP_SAMPLES) + 1;
  out = createLogMel()(pcm, 0, frames);
}
writeFileSync(output, Buffer.from(out.buffer));
console.log(`${input.split('/').at(-1)}: ${out.length / 80} rows`);