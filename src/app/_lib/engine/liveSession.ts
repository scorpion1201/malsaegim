/**
 * 실시간 받아쓰기 상태 기계 — 오디오 창을 반복 인식해 부분 자막과 확정 자막을 낸다. 인식기는 주입받는다(워커·테스트).
 *
 * 버퍼: 마지막으로 확정한 지점 ~ 지금. 마이크 프레임은 계속 쌓이고 인식 요청은 한 번에 하나만 보낸다.
 * 갱신(부분): 새 오디오가 STEP_MS 쌓이면 창 전체를 다시 인식한다. 연속한 두 결과가 앞에서부터 같은 어절(LocalAgreement-2)은
 *       확정한다 — 확정한 어절은 다시 바뀌지 않는다. 버퍼는 문장이 확정될 때만 그 끝으로 자르고, 같은 문장 안에서 다시
 *       나오는 확정 어절은 시각과 끝부분 n-gram 으로 걸러 낸다(whisper_streaming 방식).
 * 발화 끝: ENDPOINT_MS 무음이면 창 전체를 한 번 더 인식해 모두 확정한다(flush).
 * 긴 발화·지연: 창이 MAX_WINDOW_MS 를 넘으면 그 안의 무음(없으면 어절 경계)에서 잘라 앞부분을 flush 한다.
 *       추론이 입력보다 느린 기기에서는 이렇게 20초 이하 조각으로 밀린 오디오를 차례로 처리한다 — 요청은 쌓이지 않고
 *       자막만 늦어진다. 밀린 오디오가 BACKLOG_LIMIT_MS 를 넘으면 오래된 구간을 건너뛰고 그 구간을 자막에 표시한다.
 * 무음: 말소리가 없는 동안은 인식하지 않는다 (환각 방지·전력).
 * 종료: finish 는 남은 말소리를 모두 flush 한 뒤 끝난다. terminate 뒤 도착한 결과는 버린다.
 */
import { createVoiceDetector } from '@/app/_lib/audio/voiceDetector';
import type { LiveSegment } from './liveTypes';
import type { LiveWord } from './whisperProtocol';

export const LIVE_SAMPLE_RATE = 16000;
/** 직전 인식 뒤 이만큼 새 오디오가 쌓여야 다시 인식한다 */
const STEP_MS = 1000;
/** 창이 이보다 짧으면 부분 인식을 하지 않는다 */
const MIN_WINDOW_MS = 800;
/** 말소리 뒤 이만큼 조용하면 발화 끝 */
const ENDPOINT_MS = 700;
/**
 * 발화 끝 flush 는 마지막 말소리(hangover 포함) 뒤 이만큼까지만 — 다음 발화의 첫머리를 넣지 않고,
 * 문장 뒤 무음을 짧게 둔다(무음이 길면 whisper 가 "MBC" 같은 꼬리 환각을 붙인다)
 */
const FLUSH_PAD_MS = 100;
/** 창 안의 말소리가 이보다 짧으면 인식하지 않고 버린다 (잡음·숨소리) */
const MIN_SPEECH_MS = 300;
/** 한 번에 인식하는 창의 상한 — whisper 입력(30초)보다 짧게 */
const MAX_WINDOW_MS = 20_000;
/** 긴 창을 자를 때 이보다 앞에서는 자르지 않는다 */
const MIN_CUT_MS = 8000;
/** 자를 자리로 쓰는 무음 길이 */
const CUT_SILENCE_MS = 300;
/** 창 끝에 걸친 어절은 다음 인식까지 확정하지 않는다 */
const GUARD_MS = 300;
/** 이미 확정한 어절이 새 결과에 다시 나올 때 시각 오차 허용치 — whisper 토큰 시각은 수백 ms 어긋난다 */
const OVERLAP_TOL_MS = 400;
/** 새 결과 맨 앞이 확정한 끝부분과 이 길이(어절)까지 겹치면 지운다 */
const MAX_OVERLAP_WORDS = 5;
/** 새 결과 앞부분을 확정 문장과 맞출 때 허용하는 글자 오류 비율 */
const ALIGN_MAX_ERROR = 0.35;
/** 말소리 전 무음은 이만큼만 남긴다 */
const PREROLL_MS = 300;
/** 확정 안 된 문장이 이보다 길면 문장부호가 없어도 내보낸다 */
const MAX_SENTENCE_MS = 15_000;
/** 처리 못 한 오디오의 상한 — 넘으면 오래된 구간을 건너뛴다 (16 kHz float32 10분 ≈ 38 MB) */
const BACKLOG_LIMIT_MS = 10 * 60_000;
/** 무음 동안 처리 시각을 알리는 간격 (지연 표시가 무음 때문에 늘지 않게) */
const IDLE_REPORT_MS = 500;
/** 마지막 발화를 기다리는 시간: 기본 + 남은 오디오의 배수 (느린 기기에서 긴 창 하나에 수십 초) */
const FINISH_BASE_MS = 60_000;
const FINISH_PER_AUDIO = 4;

type Word = { t0: number; t1: number; text: string };
type Mark = { endMs: number; speech: boolean };

export type Recognition = { promise: Promise<LiveWord[]>; cancel: () => void };
/** 창(16 kHz PCM)을 인식한다. audioCtx 는 whisper 인코더 길이(0 = 30초), range 는 창의 녹음 시각 */
export type Recognize = (pcm: Float32Array, audioCtx: number, range: { startMs: number; endMs: number }) => Recognition;

export type LiveSessionHandlers = {
  onPartial: (text: string, processedMs: number) => void;
  onFinal: (segment: LiveSegment) => void;
  onError: (error: Error) => void;
  /** 인식기가 죽었다 — 되살렸으면 true (그동안 들어온 오디오는 버퍼에 남아 이어서 처리한다) */
  recover: (error: Error) => Promise<boolean>;
  log?: (message: string) => void;
};

export type LiveSessionOptions = {
  /**
   * 부분 자막 인식을 창 길이만큼만 인코딩한다(audio_ctx) — CPU 에서 빠르지만 꼬리 환각·반복이 생길 수 있어
   * 노트에 남는 확정(flush) 인식은 항상 30초 전체 인코더로 돌린다 (정확도 우선)
   */
  reduceAudioCtx: boolean;
};

export type LiveSessionStats = { passes: number; inferMs: number; skippedMs: number; audioMs: number };

export type LiveSession = {
  push: (samples: Float32Array) => void;
  finish: () => Promise<void>;
  terminate: () => void;
  stats: () => LiveSessionStats;
};

const normalize = (text: string): string => text.replace(/[.,?!…~"'“”‘’·、。]/g, '').toLowerCase();
const endsSentence = (text: string): boolean => /[.?!。？！]$/.test(text);
const joinWords = (words: Word[]): string => words.map((word) => word.text).join(' ');
const clock = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};

/** 앞에서부터 같은 어절 수 */
const agreedPrefix = (previous: Word[], current: Word[]): number => {
  let n = 0;
  while (n < previous.length && n < current.length && normalize(previous[n].text) === normalize(current[n].text)) n += 1;
  return n;
};

/** 창 길이(ms) → whisper audio_ctx (20 ms 단위 인코더 프레임, 여유 64) */
export const audioCtxFor = (windowMs: number): number => Math.min(1500, Math.ceil(windowMs / 20) + 64);

export const createLiveSession = (recognize: Recognize, handlers: LiveSessionHandlers, options: LiveSessionOptions): LiveSession => {
  let chunks: Float32Array[] = [];
  let marks: Mark[] = [];
  /** 버퍼 첫 샘플의 녹음 시각 */
  let bufStartMs = 0;
  /** 받은 오디오 끝 시각 */
  let totalMs = 0;
  const detector = createVoiceDetector();
  /** 직전 부분 인식의 미확정 어절 (녹음 시각) */
  let hypothesis: Word[] = [];
  /** 확정했지만 아직 문장으로 내보내지 않은 어절 */
  let sentence: Word[] = [];
  /** 최근에 확정한 어절 — 버퍼는 문장이 끝날 때만 자르므로 다음 창에 다시 나오는 확정 어절을 이것으로 걸러 낸다 */
  let committed: Word[] = [];
  let lastFinalEndMs = 0;
  let lastPassEndMs = 0;
  let lastIdleReport = -Infinity;
  let inflight: Recognition | null = null;
  let recovering = false;
  let closed = false;
  let finishing: (() => void) | null = null;
  const stats: LiveSessionStats = { passes: 0, inferMs: 0, skippedMs: 0, audioMs: 0 };

  const bufferMs = () => totalMs - bufStartMs;
  const lastSpeechMs = (): number => {
    for (let i = marks.length - 1; i >= 0; i -= 1) if (marks[i].speech) return marks[i].endMs;
    return -Infinity;
  };
  const hasSpeechAfter = (ms: number): boolean => marks.some((mark) => mark.speech && mark.endMs > ms);
  /** 버퍼 시작 ~ end 사이 말소리 길이 */
  const speechMs = (end: number): number => {
    let sum = 0;
    let previousEnd = bufStartMs;
    for (const mark of marks) {
      if (mark.endMs > end) break;
      if (mark.speech) sum += mark.endMs - previousEnd;
      previousEnd = mark.endMs;
    }
    return sum;
  };

  /** 버퍼 앞을 ms(녹음 시각)까지 버린다 */
  const trimTo = (ms: number) => {
    const target = Math.min(totalMs, Math.max(bufStartMs, ms));
    let drop = Math.round(((target - bufStartMs) / 1000) * LIVE_SAMPLE_RATE);
    while (drop > 0 && chunks.length > 0) {
      const head = chunks[0];
      if (head.length <= drop) {
        drop -= head.length;
        chunks.shift();
      } else {
        chunks[0] = head.subarray(drop);
        drop = 0;
      }
    }
    bufStartMs = target;
    marks = marks.filter((mark) => mark.endMs > target);
  };

  /** 버퍼 앞에서 ms 만큼 복사한다 */
  const slice = (ms: number): Float32Array => {
    const length = Math.min(
      Math.round((ms / 1000) * LIVE_SAMPLE_RATE),
      chunks.reduce((sum, chunk) => sum + chunk.length, 0),
    );
    const pcm = new Float32Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      if (offset >= length) break;
      const take = Math.min(chunk.length, length - offset);
      pcm.set(chunk.subarray(0, take), offset);
      offset += take;
    }
    return pcm;
  };

  const partialText = () => joinWords([...sentence, ...hypothesis]);
  const report = (processedMs: number) => handlers.onPartial(partialText(), processedMs);

  const emit = (words: Word[]) => {
    if (words.length === 0) return;
    const startMs = Math.max(Math.round(words[0].t0), lastFinalEndMs);
    const endMs = Math.max(Math.round(words[words.length - 1].t1), startMs);
    lastFinalEndMs = endMs;
    handlers.onFinal({ text: joinWords(words), startMs, endMs });
  };

  /** 확정 어절을 문장 단위로 내보낸다. force 면 남은 것까지. 내보낸 마지막 어절의 끝 시각(없으면 null) */
  const flushSentences = (force: boolean): number | null => {
    let start = 0;
    let emittedEnd: number | null = null;
    for (let i = 0; i < sentence.length; i += 1) {
      if (endsSentence(sentence[i].text) || sentence[i].t1 - sentence[start].t0 >= MAX_SENTENCE_MS) {
        emit(sentence.slice(start, i + 1));
        emittedEnd = sentence[i].t1;
        start = i + 1;
      }
    }
    sentence = sentence.slice(start);
    if (force && sentence.length > 0) {
      emittedEnd = sentence[sentence.length - 1].t1;
      emit(sentence);
      sentence = [];
    }
    return emittedEnd;
  };

  const commit = (words: Word[]) => {
    if (words.length === 0) return;
    sentence.push(...words);
    committed = [...committed, ...words].slice(-MAX_OVERLAP_WORDS * 2);
  };

  /** 앞에서 (정규화한) 글자 n 개를 걷어 낸다 — 경계가 어절 가운데면 그 어절을 나눠 뒷부분을 남긴다 */
  const dropChars = (words: Word[], n: number): Word[] => {
    const out = [...words];
    let left = n;
    while (left > 0 && out.length > 0) {
      const word = out[0];
      const length = normalize(word.text).length;
      if (length <= left) {
        left -= length;
        out.shift();
        continue;
      }
      let index = 0;
      for (let counted = 0; index < word.text.length && counted < left; index += 1) if (normalize(word.text[index])) counted += 1;
      out[0] = { t0: word.t0 + ((word.t1 - word.t0) * index) / word.text.length, t1: word.t1, text: word.text.slice(index) };
      left = 0;
    }
    return out.filter((word) => normalize(word.text).length > 0);
  };

  /**
   * 새 결과 앞부분 중 아직 내보내지 않은 확정 문장(sentence)을 다시 인식한 부분을 걷어 낸다.
   * 버퍼는 그 문장의 시작부터 있으므로 새 결과는 "확정 문장 + 새 말" 이다. whisper 는 같은 말을 창마다 다르게 띄어 쓰고
   * (확정 경계를 가로질러 붙여 쓰기도 한다) 토큰 시각도 수백 ms 어긋나므로, 공백을 뺀 글자열에서 확정 문장과
   * 편집거리가 가장 작은 앞부분 길이를 찾아 그만큼 걷어 낸다
   */
  const alignCommitted = (words: Word[]): Word[] | null => {
    const target = sentence.map((word) => normalize(word.text)).join('');
    if (!target) return words;
    const stream = words.map((word) => normalize(word.text)).join('');
    const limit = Math.min(stream.length, Math.ceil(target.length * 1.5) + 4);
    // row[j] = 편집거리(stream 앞 i 글자, target 앞 j 글자). i 마다 row[target.length] 가 후보 비용이다
    let row = Array.from({ length: target.length + 1 }, (_, j) => j);
    let best = { chars: 0, cost: target.length };
    for (let i = 1; i <= limit; i += 1) {
      const next = [i];
      for (let j = 1; j <= target.length; j += 1) {
        next.push(Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (stream[i - 1] === target[j - 1] ? 0 : 1)));
      }
      row = next;
      if (row[target.length] < best.cost) best = { chars: i, cost: row[target.length] };
    }
    return best.cost <= Math.max(2, target.length * ALIGN_MAX_ERROR) ? dropChars(words, best.chars) : null;
  };

  /** 확정 문장이 없거나 정렬이 안 되면 — 이미 확정한 시각보다 앞선 어절을 빼고, 확정 끝부분과 글자로 겹치는 앞부분을 지운다 */
  const afterCommitted = (words: Word[]): Word[] => {
    const end = committed.at(-1)?.t1 ?? -Infinity;
    const rest = words.filter((word) => word.t1 > end - OVERLAP_TOL_MS);
    if (rest.length === 0 || rest[0].t0 > end + OVERLAP_TOL_MS * 4) return rest;
    const tail = committed
      .slice(-MAX_OVERLAP_WORDS)
      .map((word) => normalize(word.text))
      .join('');
    const head = rest
      .slice(0, MAX_OVERLAP_WORDS)
      .map((word) => normalize(word.text))
      .join('');
    for (let length = Math.min(tail.length, head.length); length >= 2; length -= 1) {
      if (tail.endsWith(head.slice(0, length))) return dropChars(rest, length);
    }
    return rest;
  };

  const fresh = (words: Word[]): Word[] => (sentence.length > 0 ? alignCommitted(words) : null) ?? afterCommitted(words);

  /** 처리 못 하고 건너뛴 구간 — 자막에 표시해 저장 WAV 로 다시 인식할 수 있게 한다 */
  const skip = (untilMs: number) => {
    if (untilMs <= bufStartMs) return;
    const from = bufStartMs;
    commit(hypothesis.filter((word) => word.t1 <= untilMs));
    hypothesis = [];
    flushSentences(true);
    stats.skippedMs += untilMs - from;
    lastFinalEndMs = Math.max(lastFinalEndMs, from);
    handlers.onFinal({ text: `[실시간 인식이 밀려 건너뛴 구간 ${clock(from)}–${clock(untilMs)}]`, startMs: Math.round(from), endMs: Math.round(untilMs) });
    lastFinalEndMs = Math.round(untilMs);
    trimTo(untilMs);
    handlers.log?.(`skipped ${Math.round(untilMs - from)} ms of backlog`);
  };

  /** 긴 창을 자를 자리 — 무음 한가운데, 없으면 마지막 부분 인식의 어절 경계, 그것도 없으면 상한 */
  const cutPoint = (): number => {
    const from = bufStartMs + MIN_CUT_MS;
    const to = bufStartMs + MAX_WINDOW_MS;
    let best: number | null = null;
    let runStart: number | null = null;
    let previousEnd = bufStartMs;
    for (const mark of marks) {
      const start = previousEnd;
      previousEnd = mark.endMs;
      if (mark.endMs > to) break;
      if (mark.speech) {
        runStart = null;
        continue;
      }
      runStart ??= start;
      if (mark.endMs - runStart >= CUT_SILENCE_MS && mark.endMs >= from) best = (runStart + mark.endMs) / 2;
    }
    if (best !== null) return best;
    const boundary = [...hypothesis].reverse().find((word) => word.t1 >= from && word.t1 <= to - GUARD_MS);
    return boundary ? boundary.t1 : to;
  };

  const finalizeIfDone = () => {
    if (!finishing || inflight || recovering) return;
    if (hasSpeechAfter(bufStartMs) && bufferMs() > 0) {
      schedule();
      return;
    }
    commit(hypothesis);
    hypothesis = [];
    flushSentences(true);
    finishing();
  };

  const apply = (raw: LiveWord[], windowStart: number, windowEnd: number, flush: boolean) => {
    const words = fresh(raw.map((word) => ({ t0: windowStart + word.t0, t1: windowStart + word.t1, text: word.text })));
    if (flush) {
      commit(words);
      flushSentences(true);
      hypothesis = [];
      trimTo(windowEnd);
    } else {
      const agreed = agreedPrefix(hypothesis, words);
      let n = 0;
      while (n < agreed && words[n].t1 <= windowEnd - GUARD_MS) n += 1;
      commit(words.slice(0, n));
      hypothesis = words.slice(n);
      // 버퍼는 문장이 끝났을 때만 그 끝으로 자른다 — 문장 안에서는 앞 문맥을 그대로 두어 인식이 흔들리지 않게 한다
      const emittedEnd = flushSentences(false);
      if (emittedEnd !== null) trimTo(emittedEnd);
    }
    report(windowEnd);
  };

  const run = (windowEnd: number, flush: boolean) => {
    const windowStart = bufStartMs;
    const pcm = slice(windowEnd - windowStart);
    lastPassEndMs = windowEnd;
    const audioCtx = options.reduceAudioCtx && !flush ? audioCtxFor(windowEnd - windowStart) : 0;
    const startedAt = Date.now();
    const recognition = recognize(pcm, audioCtx, { startMs: windowStart, endMs: windowEnd });
    inflight = recognition;
    recognition.promise.then(
      (words) => {
        if (closed || inflight !== recognition) return;
        inflight = null;
        stats.passes += 1;
        stats.inferMs += Date.now() - startedAt;
        handlers.log?.(
          `pass ${stats.passes}${flush ? ' flush' : ''}: ${Math.round(windowEnd - windowStart)} ms window in ${Date.now() - startedAt} ms (lag ${Math.round(totalMs - windowEnd)} ms)`,
        );
        apply(words, windowStart, windowEnd, flush);
        schedule();
        finalizeIfDone();
      },
      (error: unknown) => {
        if (closed || inflight !== recognition) return;
        inflight = null;
        recovering = true;
        const failure = error instanceof Error ? error : new Error(String(error));
        handlers
          .recover(failure)
          .then((ok) => {
            recovering = false;
            if (closed) return;
            if (!ok) {
              handlers.onError(failure);
              closed = true;
              finishing?.();
              return;
            }
            schedule();
            finalizeIfDone();
          })
          .catch(() => {
            recovering = false;
          });
      },
    );
  };

  function schedule() {
    if (closed || inflight || recovering) return;
    if (!hasSpeechAfter(bufStartMs)) {
      if (totalMs - lastIdleReport >= IDLE_REPORT_MS) {
        lastIdleReport = totalMs;
        report(totalMs);
      }
      return;
    }
    if (bufferMs() > MAX_WINDOW_MS) {
      run(cutPoint(), true);
      return;
    }
    if (finishing || totalMs - lastSpeechMs() >= ENDPOINT_MS) {
      // 녹음을 끝낼 때는 뒤에 올 발화가 없으니 마지막 샘플까지 인식한다
      const end = finishing ? totalMs : Math.min(totalMs, lastSpeechMs() + FLUSH_PAD_MS);
      if (speechMs(end) < MIN_SPEECH_MS) {
        // 잡음 한두 프레임 — 인식하지 않는다
        hypothesis = [];
        flushSentences(true);
        trimTo(end);
        report(end);
        finalizeIfDone();
        return;
      }
      run(end, true);
      return;
    }
    if (totalMs - lastPassEndMs >= STEP_MS && bufferMs() >= MIN_WINDOW_MS) run(totalMs, false);
  }

  return {
    push: (samples) => {
      if (closed || finishing) return;
      const frameMs = (samples.length / LIVE_SAMPLE_RATE) * 1000;
      chunks.push(samples.slice());
      totalMs += frameMs;
      stats.audioMs = totalMs;
      marks.push({ endMs: totalMs, speech: detector.classify(samples) });
      // 말소리가 없으면 프리롤만 남긴다 — 무음은 인식하지 않는다. 버린 오디오의 미확정 결과도 버리고, 확정한 어절은 내보낸다
      if (!inflight && !hasSpeechAfter(bufStartMs) && bufferMs() > PREROLL_MS * 2) {
        hypothesis = [];
        flushSentences(true);
        trimTo(totalMs - PREROLL_MS);
      }
      // 추론이 입력을 오래 못 따라가면 오래된 구간을 건너뛴다 (진행 중인 창 이후부터)
      if (bufferMs() > BACKLOG_LIMIT_MS && !inflight) skip(totalMs - MAX_WINDOW_MS);
      schedule();
    },
    finish: () =>
      new Promise<void>((resolve) => {
        if (closed) {
          resolve();
          return;
        }
        const timer = setTimeout(() => {
          // 남은 오디오를 끝내 처리하지 못했다 — 받은 자막까지 확정하고 남은 구간은 건너뛴 구간으로 표시한다
          inflight?.cancel();
          inflight = null;
          if (hasSpeechAfter(bufStartMs)) skip(totalMs);
          commit(hypothesis);
          hypothesis = [];
          flushSentences(true);
          done();
        }, FINISH_BASE_MS + FINISH_PER_AUDIO * bufferMs());
        const done = () => {
          clearTimeout(timer);
          closed = true;
          resolve();
        };
        finishing = done;
        finalizeIfDone();
      }),
    terminate: () => {
      if (closed) return;
      closed = true;
      inflight?.cancel();
      inflight = null;
      chunks = [];
      marks = [];
    },
    stats: () => ({ ...stats }),
  };
};