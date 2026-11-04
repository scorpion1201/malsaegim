'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChunkMeta } from '@/app/_lib/asr/assembleTranscript';
import { DEFAULT_LIVE_CHUNKER_OPTIONS, LiveChunker, type LiveChunk } from '@/app/_lib/audio/liveChunker';
import { startMicCapture, type MicCapture } from '@/app/_lib/audio/micCapture';
import {
  deleteRecordingParts,
  listRecordingParts,
  putRecording,
  putRecordingPart,
} from '@/app/_lib/audio/recordingStore';
import type { AudioChunk } from '@/app/_lib/audio/types';
import { RECORDING_SAMPLE_RATE, buildWavBlob, encodeWavPcm16 } from '@/app/_lib/audio/wav';

export type LiveRecordingStatus = 'idle' | 'starting' | 'recording' | 'paused' | 'stopping';

export type LiveRecordingResult = {
  blob: Blob;
  durationMs: number;
  chunkCount: number;
};

type LiveRecordingHandlers = {
  /** 인식 API 로 보낼 조각 (500ms 이상) */
  onChunk: (chunk: AudioChunk) => void;
  /** 너무 짧거나 무음뿐이라 보내지 않는 조각 — 순서가 비지 않도록 빈 결과로 채운다 */
  onSkipped: (meta: ChunkMeta) => void;
  /** IndexedDB 조각 저장 실패 (녹음은 계속된다) */
  onStoreError: (error: Error) => void;
  /** 시간축에 들어간 100ms 프레임 — 실시간 엔진용 */
  onFrame?: (frame: Float32Array) => void;
};

/** 인식 API 에 보내는 최소 길이 — 이보다 짧은 조각은 저장만 한다 */
const MIN_SEND_MS = 500;
/** 파형에 남겨 두는 프레임 수 (100ms 단위 → 60초) */
const MAX_LEVELS = 600;

/**
 * 마이크 녹음 한 회차의 상태 기계. 조각이 잘릴 때마다 (1) IndexedDB parts 에 PCM 을 쌓고 (2) WAV 로 감싸 onChunk 로 넘긴다.
 * stop() 은 parts 를 한 WAV 로 이어 recordings 에 넣고 parts 를 지운다.
 */
export const useLiveRecording = (handlers: LiveRecordingHandlers) => {
  const [status, setStatus] = useState<LiveRecordingStatus>('idle');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [emittedMs, setEmittedMs] = useState(0);
  const [chunkCount, setChunkCount] = useState(0);

  const levelsRef = useRef<number[]>([]);
  const handlersRef = useRef(handlers);
  const captureRef = useRef<MicCapture | null>(null);
  const chunkerRef = useRef<LiveChunker | null>(null);
  const projectIdRef = useRef<string | null>(null);
  const writesRef = useRef<Promise<void>[]>([]);

  useEffect(() => {
    handlersRef.current = handlers;
  });

  // 경과 시간은 청커가 실제로 받은 샘플 수로 센다 (일시정지 구간 제외)
  useEffect(() => {
    if (status !== 'recording') return;
    const timer = setInterval(() => setElapsedMs(chunkerRef.current?.recordedMs ?? 0), 250);
    return () => clearInterval(timer);
  }, [status]);

  useEffect(
    () => () => {
      void captureRef.current?.stop().catch(() => {});
    },
    [],
  );

  // 녹음하는 동안 화면이 저절로 꺼지지 않게 한다 — iPad·iPhone 은 화면이 꺼지면 마이크가 멈춘다.
  // 화면을 벗어나면 브라우저가 잠금을 풀므로 돌아올 때 다시 건다. 지원하지 않거나 거절되면 그냥 둔다
  const holdScreen = status === 'recording' || status === 'paused';
  useEffect(() => {
    if (!holdScreen || !('wakeLock' in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let disposed = false;
    const acquire = () => {
      if (document.visibilityState !== 'visible') return;
      navigator.wakeLock
        .request('screen')
        .then((sentinel) => {
          if (disposed) void sentinel.release();
          else lock = sentinel;
        })
        .catch(() => {});
    };
    acquire();
    document.addEventListener('visibilitychange', acquire);
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', acquire);
      void lock?.release().catch(() => {});
    };
  }, [holdScreen]);

  const start = useCallback(async (projectId: string, sharedTrack?: MediaStreamTrack) => {
    setStatus('starting');
    levelsRef.current = [];
    writesRef.current = [];
    projectIdRef.current = projectId;
    setElapsedMs(0);
    setEmittedMs(0);
    setChunkCount(0);

    const chunker = new LiveChunker(
      DEFAULT_LIVE_CHUNKER_OPTIONS,
      (chunk: LiveChunk) => {
        const write = putRecordingPart(projectId, chunk.index, chunk.pcm.buffer as ArrayBuffer).catch((error: unknown) =>
          handlersRef.current.onStoreError(error instanceof Error ? error : new Error(String(error))),
        );
        writesRef.current.push(write);
        const meta: ChunkMeta = { index: chunk.index, startMs: chunk.startMs, endMs: chunk.endMs };
        if (chunk.voiced && chunk.endMs - chunk.startMs >= MIN_SEND_MS) {
          handlersRef.current.onChunk({ ...meta, wav: encodeWavPcm16(chunk.pcm, RECORDING_SAMPLE_RATE) });
        } else {
          handlersRef.current.onSkipped(meta);
        }
        setEmittedMs(chunk.endMs);
        setChunkCount(chunk.index + 1);
      },
      (rms) => {
        const levels = levelsRef.current;
        levels.push(rms);
        if (levels.length > MAX_LEVELS) levels.splice(0, levels.length - MAX_LEVELS);
      },
      // 실시간 엔진에는 저장 WAV 와 같은 시간축의 프레임을 준다 — 첫 말소리 전 무음은 저장본처럼 빠져 자막 시각이 저장 파일과 맞는다.
      // 청커가 프레임을 시간축에 넣은 뒤(조각을 자르기 전) 부르므로 조각 경계는 항상 그 프레임 뒤에 온다
      (frame) => handlersRef.current.onFrame?.(frame),
    );
    chunkerRef.current = chunker;

    try {
      // startMicCapture 가 네이티브→16kHz 연속 리샘플까지 해서 항상 16kHz 를 준다.
      // 저장·BYOK 청크는 청커가 문장 단위로 자르고, 실시간 엔진은 청커 시간축의 100ms 프레임을 그대로 받는다.
      const capture = await startMicCapture((samples) => chunker.push(samples), sharedTrack);
      captureRef.current = capture;
    } catch (error) {
      chunkerRef.current = null;
      projectIdRef.current = null;
      setStatus('idle');
      throw error;
    }
    setStatus('recording');
  }, []);

  const pause = useCallback(() => {
    if (!captureRef.current) return;
    captureRef.current.pause();
    chunkerRef.current?.flush();
    setStatus('paused');
  }, []);

  /** 마이크를 다시 열지 못하면(권한 철회 등) 거절된다 — 상태는 녹음으로 돌린다 */
  const resume = useCallback(async () => {
    if (!captureRef.current) return;
    setStatus('recording');
    await captureRef.current.resume();
  }, []);

  const stop = useCallback(async (): Promise<LiveRecordingResult> => {
    const capture = captureRef.current;
    const chunker = chunkerRef.current;
    const projectId = projectIdRef.current;
    if (!chunker || !projectId) throw new Error('녹음 중이 아닙니다');
    setStatus('stopping');
    captureRef.current = null;
    chunkerRef.current = null;
    projectIdRef.current = null;
    if (capture) await capture.stop();
    chunker.flush();
    await Promise.all(writesRef.current);
    const parts = await listRecordingParts(projectId);
    const blob = buildWavBlob(parts, RECORDING_SAMPLE_RATE);
    const durationMs = Math.round(chunker.emittedMs);
    await putRecording({ id: projectId, blob, mimeType: 'audio/wav', durationMs, updatedAt: Date.now() });
    await deleteRecordingParts(projectId);
    setElapsedMs(durationMs);
    setStatus('idle');
    return { blob, durationMs, chunkCount: chunker.chunkCount };
  }, []);

  return { status, elapsedMs, emittedMs, chunkCount, levelsRef, start, pause, resume, stop };
};