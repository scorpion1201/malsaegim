/**
 * CAM++ 입력 특징 — Kaldi 방식 80차 log-mel filterbank (25 ms 창, 10 ms 간격, povey 창, 프리엠퍼시스 0.97).
 * 창마다 시간축 평균을 빼므로(global-mean) 입력 크기가 달라도 결과가 같다.
 */
const SAMPLE_RATE = 16000;
const FRAME_SAMPLES = 400;
export const HOP_SAMPLES = 160;
const FFT_SIZE = 512;
export const MEL_BINS = 80;
const LOW_HZ = 20;
const HIGH_HZ = SAMPLE_RATE / 2;
const PREEMPHASIS = 0.97;
const ENERGY_FLOOR = 1.19e-7;

const hzToMel = (hz: number): number => 1127 * Math.log(1 + hz / 700);

type Filter = { bin: number; weight: number }[];

const melFilters = (): Filter[] => {
  const low = hzToMel(LOW_HZ);
  const step = (hzToMel(HIGH_HZ) - low) / (MEL_BINS + 1);
  return Array.from({ length: MEL_BINS }, (_, index) => {
    const left = low + step * index;
    const center = left + step;
    const right = center + step;
    const filter: Filter = [];
    for (let bin = 0; bin <= FFT_SIZE / 2; bin += 1) {
      const mel = hzToMel((bin * SAMPLE_RATE) / FFT_SIZE);
      if (mel > left && mel < right) filter.push({ bin, weight: mel <= center ? (mel - left) / step : (right - mel) / step });
    }
    return filter;
  });
};

/** 창 하나(frames × MEL_BINS)의 특징을 만드는 함수를 돌려준다. 내부 버퍼를 재사용하므로 한 스레드에서만 쓴다 */
export const createFbank = (frames: number): ((pcm: Int16Array, start: number) => Float32Array) => {
  const window = Float64Array.from({ length: FRAME_SAMPLES }, (_, i) => (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME_SAMPLES - 1))) ** 0.85);
  const filters = melFilters();
  const cosines = Float64Array.from({ length: FFT_SIZE / 2 }, (_, i) => Math.cos((2 * Math.PI * i) / FFT_SIZE));
  const sines = Float64Array.from({ length: FFT_SIZE / 2 }, (_, i) => Math.sin((2 * Math.PI * i) / FFT_SIZE));
  const bits = Math.log2(FFT_SIZE);
  const reversed = Uint16Array.from({ length: FFT_SIZE }, (_, index) => {
    let out = 0;
    for (let bit = 0; bit < bits; bit += 1) if (index & (1 << bit)) out |= 1 << (bits - 1 - bit);
    return out;
  });
  const real = new Float64Array(FFT_SIZE);
  const imag = new Float64Array(FFT_SIZE);
  const frame = new Float64Array(FRAME_SAMPLES);

  const fft = () => {
    for (let i = 0; i < FFT_SIZE; i += 1) {
      const j = reversed[i];
      if (i < j) [real[i], real[j]] = [real[j], real[i]];
    }
    imag.fill(0);
    for (let size = 2; size <= FFT_SIZE; size *= 2) {
      const half = size / 2;
      const step = FFT_SIZE / size;
      for (let start = 0; start < FFT_SIZE; start += size) {
        for (let j = 0, k = 0; j < half; j += 1, k += step) {
          const a = start + j;
          const b = a + half;
          const tr = real[b] * cosines[k] + imag[b] * sines[k];
          const ti = imag[b] * cosines[k] - real[b] * sines[k];
          real[b] = real[a] - tr;
          imag[b] = imag[a] - ti;
          real[a] += tr;
          imag[a] += ti;
        }
      }
    }
  };

  const melFrame = (pcm: Int16Array, start: number, out: Float32Array, offset: number) => {
    let mean = 0;
    for (let i = 0; i < FRAME_SAMPLES; i += 1) {
      frame[i] = pcm[start + i];
      mean += frame[i];
    }
    mean /= FRAME_SAMPLES;
    for (let i = 0; i < FRAME_SAMPLES; i += 1) frame[i] -= mean;
    for (let i = FRAME_SAMPLES - 1; i > 0; i -= 1) frame[i] -= PREEMPHASIS * frame[i - 1];
    frame[0] -= PREEMPHASIS * frame[0];
    real.fill(0);
    for (let i = 0; i < FRAME_SAMPLES; i += 1) real[i] = frame[i] * window[i];
    fft();
    for (let mel = 0; mel < MEL_BINS; mel += 1) {
      let energy = 0;
      for (const { bin, weight } of filters[mel]) energy += (real[bin] * real[bin] + imag[bin] * imag[bin]) * weight;
      out[offset + mel] = Math.log(Math.max(energy, ENERGY_FLOOR));
    }
  };

  return (pcm, start) => {
    const out = new Float32Array(frames * MEL_BINS);
    for (let t = 0; t < frames; t += 1) melFrame(pcm, start + t * HOP_SAMPLES, out, t * MEL_BINS);
    for (let mel = 0; mel < MEL_BINS; mel += 1) {
      let mean = 0;
      for (let t = 0; t < frames; t += 1) mean += out[t * MEL_BINS + mel];
      mean /= frames;
      for (let t = 0; t < frames; t += 1) out[t * MEL_BINS + mel] -= mean;
    }
    return out;
  };
};