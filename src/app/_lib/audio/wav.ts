import type { SplitHandle } from './splitAudioFile';
import type { AudioChunk, ExtractRange, SplitSummary } from './types';

/** 녹음 노트의 저장 포맷: 모노 PCM16 16kHz WAV — 인식 API 입력과 같아서 조각은 바이트로 잘라 쓴다 */
export const RECORDING_SAMPLE_RATE = 16000;
const HEADER_BYTES = 44;

export const floatToPcm16 = (samples: Float32Array): Int16Array => {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    out[i] = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
  }
  return out;
};

const writeAscii = (view: DataView, offset: number, text: string): void => {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
};

/** 모노 PCM16 헤더 (44바이트). dataBytes 는 샘플 데이터 바이트 수 */
export const wavHeader = (dataBytes: number, sampleRate: number): Uint8Array<ArrayBuffer> => {
  const buffer = new ArrayBuffer(HEADER_BYTES);
  const view = new DataView(buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);
  return new Uint8Array(buffer);
};

export const encodeWavPcm16 = (pcm: Int16Array, sampleRate: number): Uint8Array => {
  const dataBytes = pcm.length * 2;
  const out = new Uint8Array(HEADER_BYTES + dataBytes);
  out.set(wavHeader(dataBytes, sampleRate), 0);
  out.set(new Uint8Array(pcm.buffer, pcm.byteOffset, dataBytes), HEADER_BYTES);
  return out;
};

export type WavInfo = {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataOffset: number;
  dataBytes: number;
  durationMs: number;
};

const ascii = (bytes: Uint8Array, offset: number): string =>
  String.fromCharCode(...bytes.subarray(offset, offset + 4));

/** RIFF 청크를 훑어 fmt/data 위치를 찾는다. PCM 이 아니거나 깨진 파일이면 null */
export const readWavInfo = (bytes: Uint8Array): WavInfo | null => {
  if (bytes.length < 12 || ascii(bytes, 0) !== 'RIFF' || ascii(bytes, 8) !== 'WAVE') return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  while (offset + 8 <= bytes.length) {
    const id = ascii(bytes, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      if (body + 16 > bytes.length || view.getUint16(body, true) !== 1) return null;
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
    } else if (id === 'data') {
      if (!sampleRate || !channels || !bitsPerSample) return null;
      const dataBytes = Math.min(size, bytes.length - body);
      const bytesPerMs = (sampleRate * channels * (bitsPerSample / 8)) / 1000;
      return { sampleRate, channels, bitsPerSample, dataOffset: body, dataBytes, durationMs: Math.round(dataBytes / bytesPerMs) };
    }
    offset = body + size + (size % 2);
  }
  return null;
};

/** 시간 구간을 프레임 경계에 맞춰 잘라 새 WAV 로 만든다. endMs === null 은 끝까지 */
export const sliceWav = (bytes: Uint8Array, info: WavInfo, startMs: number, endMs: number | null): Uint8Array => {
  const frameBytes = info.channels * (info.bitsPerSample / 8);
  const bytesPerMs = (info.sampleRate * frameBytes) / 1000;
  const align = (value: number) => Math.floor(value / frameBytes) * frameBytes;
  const start = Math.min(info.dataBytes, align(Math.max(0, startMs) * bytesPerMs));
  const end = endMs === null ? info.dataBytes : Math.min(info.dataBytes, Math.max(start, align(endMs * bytesPerMs)));
  const data = bytes.subarray(info.dataOffset + start, info.dataOffset + end);
  const header = wavHeader(data.length, info.sampleRate);
  // 헤더는 모노 기준이므로 채널 수·블록 정렬·비트 수만 실제 값으로 덮어쓴다
  const view = new DataView(header.buffer);
  view.setUint16(22, info.channels, true);
  view.setUint32(28, info.sampleRate * frameBytes, true);
  view.setUint16(32, frameBytes, true);
  view.setUint16(34, info.bitsPerSample, true);
  const out = new Uint8Array(HEADER_BYTES + data.length);
  out.set(header, 0);
  out.set(data, HEADER_BYTES);
  return out;
};

/** 녹음 노트 재인식: 디코딩 없이 저장된 WAV 를 잘라 조각을 만든다 (splitAudioFile 의 SplitHandle 과 같은 모양) */
export const extractWavRanges = (
  bytes: Uint8Array,
  ranges: ExtractRange[],
  onChunk: (chunk: AudioChunk) => void,
): SplitHandle => {
  let cancelled = false;
  const done = new Promise<SplitSummary>((resolve, reject) => {
    setTimeout(() => {
      if (cancelled) return;
      const info = readWavInfo(bytes);
      if (!info) {
        reject(new Error('저장된 녹음 파일을 읽을 수 없습니다'));
        return;
      }
      for (const range of ranges) {
        if (cancelled) return;
        onChunk({
          index: range.index,
          startMs: range.startMs,
          endMs: range.endMs ?? info.durationMs,
          wav: sliceWav(bytes, info, range.startMs, range.endMs),
        });
      }
      resolve({ totalMs: info.durationMs, chunkCount: ranges.length, sampleRate: info.sampleRate });
    }, 0);
  });
  return {
    done,
    cancel: () => {
      cancelled = true;
    },
  };
};

/** PCM16 모노 WAV 들의 샘플을 이어 붙인다 — 화자 구분 입력. PCM16 이 아닌 조각은 건너뛴다 */
export const wavsToPcm16 = (wavs: Uint8Array[]): Int16Array => {
  const parts = wavs.flatMap((bytes) => {
    const info = readWavInfo(bytes);
    if (!info || info.bitsPerSample !== 16 || info.channels !== 1) return [];
    return [bytes.subarray(info.dataOffset, info.dataOffset + info.dataBytes)];
  });
  const out = new Int16Array(parts.reduce((sum, part) => sum + part.length / 2, 0));
  let offset = 0;
  for (const part of parts) {
    new Uint8Array(out.buffer, offset * 2, part.length).set(part);
    offset += part.length / 2;
  }
  return out;
};

/** PCM16 WAV → Float32 샘플 (모노 기준; 다채널이면 첫 채널) — On-Device 엔진 입력 */
export const wavToFloat32 = (bytes: Uint8Array): Float32Array => {
  const info = readWavInfo(bytes);
  if (!info || info.bitsPerSample !== 16) throw new Error('PCM16 WAV 가 아닙니다');
  const frameBytes = 2 * info.channels;
  const frames = Math.floor(info.dataBytes / frameBytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset + info.dataOffset, frames * frameBytes);
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) out[i] = view.getInt16(i * frameBytes, true) / 0x8000;
  return out;
};

/** 조각(PCM16 바이트) 목록 + 헤더 → 파일 하나. 복사 없이 Blob 으로 잇는다 */
export const buildWavBlob = (parts: ArrayBuffer[], sampleRate: number): Blob => {
  const dataBytes = parts.reduce((sum, part) => sum + part.byteLength, 0);
  return new Blob([wavHeader(dataBytes, sampleRate), ...parts], { type: 'audio/wav' });
};