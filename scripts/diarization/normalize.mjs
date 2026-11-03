// stdin 16 kHz 모노 PCM16 → 앱의 levelNormalizer(100 ms 프레임) → stdout PCM16. 녹음 저장과 같은 변환이다.
// 사용: node --import ./scripts/diarization/ts-loader.mjs scripts/diarization/normalize.mjs < in.pcm > out.pcm
import { createLevelNormalizer } from '../../src/app/_lib/audio/levelNormalizer.ts';
import { floatToPcm16 } from '../../src/app/_lib/audio/wav.ts';

const SAMPLE_RATE = 16000;
const FRAME = 1600;

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const bytes = Buffer.concat(chunks);
const input = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 2));
const normalize = createLevelNormalizer(SAMPLE_RATE);
const output = new Int16Array(input.length);
const frame = new Float32Array(FRAME);
for (let start = 0; start < input.length; start += FRAME) {
  const length = Math.min(FRAME, input.length - start);
  for (let i = 0; i < FRAME; i += 1) frame[i] = i < length ? input[start + i] / 0x8000 : 0;
  output.set(floatToPcm16(normalize(frame)).subarray(0, length), start);
}
process.stdout.write(Buffer.from(output.buffer));