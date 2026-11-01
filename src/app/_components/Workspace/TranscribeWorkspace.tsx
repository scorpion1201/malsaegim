'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { assembleTranscript, type ChunkMeta, type ChunkOutcome } from '@/app/_lib/asr/assembleTranscript';
import type { EngineKind, TranscribeEngine } from '@/app/_lib/asr/asrEngine';
import { selectEngine } from '@/app/_lib/asr/selectEngine';
import { createTranscribeQueue, type TranscribeQueue } from '@/app/_lib/asr/transcribeQueue';
import { sha256Hex } from '@/app/_lib/audio/fileHash';
import { deleteRecording, deleteRecordingParts, getRecording, putRecording } from '@/app/_lib/audio/recordingStore';
import { extractAudioRanges, splitAudioBuffer, type SplitHandle } from '@/app/_lib/audio/splitAudioFile';
import { DEFAULT_SPLIT_OPTIONS, ON_DEVICE_SPLIT_OPTIONS, type AudioChunk, type ExtractRange, type SplitOptions } from '@/app/_lib/audio/types';
import { extractWavRanges } from '@/app/_lib/audio/wav';
import { blocksToTiptapDoc } from '@/app/_lib/editor/blocksToTiptapDoc';
import { patchFailedParagraph, upgradeFailedPlaceholders } from '@/app/_lib/editor/patchTranscript';
import {
  audioKindOf,
  deleteProject,
  listProjects,
  loadProject,
  migrateLegacyDraft,
  newProjectId,
  parseProjectFile,
  saveProject,
  serializeProject,
  toMeta,
  type Project,
  type ProjectAudio,
  type ProjectMeta,
  type StoredChunk,
} from '@/app/_lib/editor/projectStore';
import type { ExportFormat } from '@/app/_lib/hwp/docModel';
import { normalizePageLayout, type PageLayout } from '@/app/_lib/hwp/pageLayout';
import { formatMb } from '@/app/_lib/engine/malsaegimEngine';
import { startLiveRecognizer, type LiveRecognizer, type LiveRecognizerHandlers } from '@/app/_lib/engine/malsaegimEngine';
import { ASR_LANGUAGE, isRealtimeTarget } from '@/app/_lib/asr/directTranscribe';
import { startRealtimeRecognizer } from '@/app/_lib/asr/realtimeRecognizer';
import { isByokComplete, readByokSettings } from '@/app/_lib/settings/byokSettings';
import type { TiptapDoc } from '@/app/_lib/hwp/tiptapToDocModel';
import { formatDateTime, formatTimestamp } from '@/app/_lib/time';
import { Editor } from '../Editor/Editor';
import { LayoutPanel } from '../LayoutPanel/LayoutPanel';
import { useModelDownload } from '../OnDevice/ModelProvider';
import { PlayerBar, type PlayerBarHandle } from '../PlayerBar/PlayerBar';
import { RecordingBar } from '../RecordingBar/RecordingBar';
import { useDialog } from '../Dialog/DialogProvider';
import { useToast } from '../Toast/ToastProvider';
import { Sidebar, type SidebarHandle } from './Sidebar';
import { TabRow } from './TabRow';
import { TopBar } from './TopBar';
import { useLiveRecording } from './useLiveRecording';
import styles from './Workspace.module.css';

type Phase = 'idle' | 'splitting' | 'transcribing' | 'recording' | 'review' | 'error';
/** 재인식용 조각 공급원 — 파일 노트는 wasm 추출, 녹음 노트는 저장된 WAV 바이트 슬라이스 */
type RangeExtractor = (ranges: ExtractRange[], onChunk: (chunk: AudioChunk) => void) => SplitHandle;
type RunMode = 'new' | 'retry';

const TRANSCRIBE_TOAST = 'transcribe';
const RETRY_TOAST = 'retry';
const MODEL_TOAST = 'model';

const stripExtension = (name: string) => name.replace(/\.[^.]+$/, '');

const AUDIO_MIME_BY_EXT: Record<string, string> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/opus',
  aiff: 'audio/aiff',
  aif: 'audio/aiff',
  caf: 'audio/x-caf',
  webm: 'audio/webm',
  weba: 'audio/webm',
};

/** 브라우저가 준 MIME 을 우선 쓰고, 없으면 확장자로 추정한다 (불러온 원본 재생용) */
const audioMime = (file: File): string =>
  file.type || AUDIO_MIME_BY_EXT[file.name.split('.').pop()?.toLowerCase() ?? ''] || 'application/octet-stream';

const downloadBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

/** 마지막 조각은 저장된 endMs 대신 "스트림 끝까지" 추출한다 (디코더 업그레이드로 총 길이가 미세하게 달라져도 안전) */
const toExtractRanges = (failed: StoredChunk[], all: StoredChunk[]): ExtractRange[] => {
  const lastIndex = all.reduce((max, chunk) => Math.max(max, chunk.index), 0);
  return failed.map((chunk) => ({
    index: chunk.index,
    startMs: chunk.startMs,
    endMs: chunk.index === lastIndex ? null : chunk.endMs,
  }));
};

const failedChunksOf = (project: Project): StoredChunk[] =>
  project.chunks.filter((chunk) => chunk.status === 'failed');

const outcomesToChunks = (outcomes: ReadonlyMap<number, ChunkOutcome>): StoredChunk[] =>
  Array.from(outcomes.values())
    .sort((a, b) => a.meta.index - b.meta.index)
    .map((outcome) => ({
      index: outcome.meta.index,
      startMs: outcome.meta.startMs,
      endMs: outcome.meta.endMs,
      status: outcome.kind === 'ok' ? 'ok' : 'failed',
    }));

const EMPTY_DOC: TiptapDoc = { type: 'doc', content: [{ type: 'paragraph' }] };
/** 녹음 노트의 문단 길이 상한 — 이 안쪽의 연속 조각은 한 문단으로 합친다 */
const LIVE_PARAGRAPH_MS = 25_000;

export const TranscribeWorkspace = () => {
  const toast = useToast();
  const dialog = useDialog();
  const router = useRouter();
  const model = useModelDownload();
  const modelRef = useRef(model);
  useEffect(() => {
    modelRef.current = model;
  });
  const [engineKind, setEngineKind] = useState<EngineKind>('byok');
  /** On-Device 진행률: 끝난 조각 길이 + 진행 중 조각 길이 × 조각 내부 진행률, 전체 길이 대비. chunkMs 는 조각 번호별 길이 */
  const onDeviceProgressRef = useRef({ doneMs: 0, currentMs: 0, currentRatio: 0, enqueuedMs: 0, chunkMs: new Map<number, number>() });
  const modelToastRef = useRef(false);
  /** 전체 길이(ms) — 진행률 분모. durationMs 상태의 ref 사본 */
  const durationRef = useRef<number | null>(null);
  const [livePartial, setLivePartial] = useState('');
  const [liveLagMs, setLiveLagMs] = useState(0);
  const [liveRestarting, setLiveRestarting] = useState(false);
  /** 이번 녹음이 스트리밍(sherpa·Realtime) 경로인지 — 렌더에서 ref 를 읽지 않으려고 상태로 둔다 */
  const [streamingLive, setStreamingLive] = useState(false);
  const liveRecognizerRef = useRef<LiveRecognizer | null>(null);
  /** On-Device 녹음의 확정 세그먼트 번호 — 조각 번호와 무관하게 0부터 */
  const liveIndexRef = useRef(0);
  /** 엔진으로 보낸 오디오 시각 — 워커가 처리한 시각과의 차이가 지연 */
  const liveSentMsRef = useRef(0);

  const [phase, setPhase] = useState<Phase>('idle');
  const [mode, setMode] = useState<RunMode>('new');
  const [source, setSource] = useState<Blob | null>(null);
  const [title, setTitle] = useState('');
  const [outcomes, setOutcomes] = useState<Map<number, ChunkOutcome>>(new Map());
  const [expectedCount, setExpectedCount] = useState<number | null>(null);
  const [durationMs, setDurationMs] = useState<number | null>(null);
  useEffect(() => {
    durationRef.current = durationMs;
  }, [durationMs]);
  const [editorValue, setEditorValue] = useState<TiptapDoc | null>(null);
  const [currentDoc, setCurrentDoc] = useState<TiptapDoc | null>(null);
  const [currentMs, setCurrentMs] = useState(0);
  const [showTimestamps, setShowTimestamps] = useState(true);
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [retryDone, setRetryDone] = useState(0);
  const [retryTotal, setRetryTotal] = useState(0);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [layoutOpen, setLayoutOpen] = useState(false);

  const playerRef = useRef<PlayerBarHandle>(null);
  const sidebarRef = useRef<SidebarHandle>(null);
  const splitRef = useRef<SplitHandle | null>(null);
  const queueRef = useRef<TranscribeQueue | null>(null);
  const docRef = useRef<TiptapDoc | null>(null);
  const activeRef = useRef<Project | null>(null);
  const pendingAudioRef = useRef<ProjectAudio | null>(null);
  const pendingRetryRef = useRef<number | null>(null);
  /** 새 파일 노트의 id — 원본 Blob 을 인식이 끝나기 전에 IndexedDB 에 넣어야 해서 미리 정한다 */
  const pendingIdRef = useRef<string | null>(null);
  const stoppingRef = useRef(false);
  /** 이번 새 노트 인식에 쓴 분할 옵션 — 엔진에 따라 다르다 (노트에 참고용으로 저장) */
  const splitOptionsRef = useRef<SplitOptions>(DEFAULT_SPLIT_OPTIONS);

  // 녹음 노트는 조각이 짧아(문장 쉼마다) 25초 안쪽의 연속 조각을 한 문단으로 합친다
  const liveNote = audioKindOf(activeProject?.audio) === 'recording';
  const assembled = useMemo(
    () => assembleTranscript(outcomes, expectedCount, liveNote ? LIVE_PARAGRAPH_MS : null),
    [outcomes, expectedCount, liveNote],
  );

  const refreshProjects = useCallback(() => {
    setProjects(listProjects(window.localStorage));
  }, []);

  const setActive = useCallback((project: Project | null) => {
    activeRef.current = project;
    setActiveProject(project);
  }, []);

  const setDoc = useCallback((doc: TiptapDoc | null) => {
    docRef.current = doc;
    setCurrentDoc(doc);
  }, []);

  const persist = useCallback(
    (project: Project) => {
      saveProject(window.localStorage, project);
      setSavedAt(project.updatedAt);
      setProjects((previous) => [toMeta(project), ...previous.filter((meta) => meta.id !== project.id)]);
    },
    [],
  );

  /** IndexedDB 에 남아 있는 원본(녹음 WAV 또는 불러온 파일)을 플레이어·재인식 소스로 붙인다 */
  const attachAudio = useCallback((project: Project) => {
    setSource(null);
    if (audioKindOf(project.audio) === 'text') return;
    void getRecording(project.id)
      .then((recording) => {
        if (recording && activeRef.current?.id === project.id) setSource(recording.blob);
      })
      .catch(() => {});
  }, []);

  // 조립 결과 → 에디터 + 진행 토스트 (새 인식 중에만)
  useEffect(() => {
    if (mode !== 'new' || (phase !== 'transcribing' && phase !== 'splitting' && phase !== 'recording')) return;
    const doc = blocksToTiptapDoc(assembled.blocks);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setEditorValue(doc);
    setDoc(doc);
    if (phase === 'transcribing' && engineKind === 'byok') {
      const total = expectedCount ?? assembled.readyCount + assembled.heldCount;
      toast.update(TRANSCRIBE_TOAST, {
        title: `인식 중 · 조각 ${assembled.readyCount}/${expectedCount ?? `${total}+`}`,
        description: assembled.heldCount > 0 ? `순서 대기 ${assembled.heldCount}` : undefined,
        progress: expectedCount ? (assembled.readyCount / expectedCount) * 100 : 0,
        meta: expectedCount ? `${Math.round((assembled.readyCount / expectedCount) * 100)}%` : undefined,
      });
    }
  }, [assembled, phase, mode, expectedCount, engineKind, setDoc, toast]);

  // 인식 시작 가드가 띄운 모델 내려받기 토스트를 진행률에 맞춰 갱신한다
  useEffect(() => {
    if (!modelToastRef.current || model.status !== 'downloading') return;
    toast.update(MODEL_TOAST, {
      title: `On-Device 모델 내려받는 중 · ${model.percent}%`,
      meta: `${formatMb(model.receivedBytes)} / ${formatMb(model.totalBytes)} MB`,
      progress: model.percent,
    });
  }, [model.status, model.percent, model.receivedBytes, model.totalBytes, toast]);

  // 새 인식이 전부 끝나면 노트로 저장하고 검수 단계로
  useEffect(() => {
    if (mode !== 'new' || phase !== 'transcribing' || !assembled.complete) return;
    const doc = docRef.current ?? blocksToTiptapDoc(assembled.blocks);
    const chunks = outcomesToChunks(outcomes);
    const now = Date.now();
    const audio = pendingAudioRef.current;
    const isRecording = audioKindOf(audio) === 'recording';
    const project: Project = {
      id: activeRef.current?.id ?? pendingIdRef.current ?? newProjectId(),
      title,
      createdAt: activeRef.current?.createdAt ?? now,
      updatedAt: now,
      audio,
      splitOptions: isRecording ? null : splitOptionsRef.current,
      chunks,
      doc,
    };
    setActive(project);
    persist(project);
    setPhase('review');
    const failed = chunks.filter((chunk) => chunk.status === 'failed').length;
    const failedHint = '실패한 조각 옆 새로고침을 누르면 그 구간만 다시 인식합니다.';
    toast.update(TRANSCRIBE_TOAST, {
      kind: failed > 0 ? 'error' : 'success',
      title: isRecording
        ? `녹음 저장됨 · ${formatTimestamp(audio?.durationMs ?? 0)}${failed > 0 ? ` · 실패 ${failed}개` : ''}`
        : failed > 0
          ? `인식 완료 · 실패 ${failed}개`
          : '인식 완료',
      description: failed > 0 ? failedHint : isRecording ? `${chunks.length}개 조각 · 이 브라우저에 저장됨` : `${chunks.length}개 조각`,
      progress: undefined,
      meta: undefined,
      duration: failed > 0 ? 8000 : 4000,
    });
  }, [mode, phase, assembled, outcomes, title, setActive, persist, toast]);

  // 최초 진입: 예전 단일 초안 마이그레이션 + 목록 로드 + 최근 노트 자동 열기
  useEffect(() => {
    migrateLegacyDraft(window.localStorage);
    const metas = listProjects(window.localStorage);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setProjects(metas);
    if (metas.length > 0) {
      const recent = loadProject(window.localStorage, metas[0].id);
      if (recent) {
        const doc = upgradeFailedPlaceholders(recent.doc, failedChunksOf(recent));
        setActive({ ...recent, doc });
        setTitle(recent.title);
        setEditorValue(doc);
        setDoc(doc);
        setDurationMs(recent.audio?.durationMs ?? null);
        setExpectedCount(recent.chunks.length > 0 ? recent.chunks.length : null);
        setSavedAt(recent.updatedAt);
        setPhase('review');
        attachAudio(recent);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 검수 단계 자동 저장 (500ms 디바운스)
  useEffect(() => {
    if (phase !== 'review' || !currentDoc || !activeProject) return;
    if (activeProject.doc === currentDoc && activeProject.title === title) return;
    const timer = setTimeout(() => {
      const updated: Project = { ...activeProject, title, doc: currentDoc, updatedAt: Date.now() };
      activeRef.current = updated;
      setActiveProject(updated);
      persist(updated);
    }, 500);
    return () => clearTimeout(timer);
  }, [phase, currentDoc, title, activeProject, persist]);

  const stop = useCallback(() => {
    splitRef.current?.cancel();
    queueRef.current?.abort();
    liveRecognizerRef.current?.terminate();
    splitRef.current = null;
    queueRef.current = null;
    liveRecognizerRef.current = null;
    setStreamingLive(false);
  }, []);

  useEffect(() => {
    if (!liveRestarting) return;
    const timer = setTimeout(() => setLiveRestarting(false), 3000);
    return () => clearTimeout(timer);
  }, [liveRestarting]);

  useEffect(() => stop, [stop]);

  const failWith = useCallback(
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      const expired = message.includes('401');
      const modelBroken = message.includes('모델을 다시 내려받아야 합니다');
      setPhase('error');
      stop();
      toast.dismiss(TRANSCRIBE_TOAST);
      toast.dismiss(RETRY_TOAST);
      toast.show({
        kind: 'error',
        title: expired ? '로그인이 만료되었습니다' : '인식을 계속할 수 없습니다',
        description: expired ? '편집 내용은 이 브라우저에 저장돼 있습니다.' : message,
        duration: 0,
        actions: expired
          ? [{ label: '다시 로그인', primary: true, onClick: () => window.location.reload() }]
          : modelBroken
            ? [{ label: '다시 받기', primary: true, onClick: () => modelRef.current.start() }]
            : undefined,
      });
    },
    [stop, toast],
  );

  /**
   * 인식을 시작할 엔진. BYOK 가 완비돼 있으면 바로, 아니면 On-Device 모델이 준비될 때까지 기다린다
   * (없으면 내려받기 시작 + 진행 토스트). 불가하면 안내 토스트를 띄우고 null
   */
  const ensureEngine = useCallback(async (): Promise<TranscribeEngine | null> => {
    const byok = isByokComplete(readByokSettings());
    const current = modelRef.current;
    if (!byok) {
      if (current.status === 'unavailable') {
        toast.show({
          kind: 'error',
          title: 'On-Device 인식을 쓸 수 없습니다',
          description: `${current.message ?? '서버에 모델이 없습니다'}. 설정에서 API 키를 넣거나 모델이 포함된 빌드가 필요합니다`,
          duration: 8000,
          actions: [{ label: '설정 열기', primary: true, onClick: () => router.push('/settings') }],
        });
        return null;
      }
      if (current.status !== 'ready') {
        modelToastRef.current = true;
        toast.show({ id: MODEL_TOAST, kind: 'progress', title: 'On-Device 모델 내려받는 중', progress: current.percent });
        const ok = await current.whenReady();
        modelToastRef.current = false;
        if (!ok) {
          toast.update(MODEL_TOAST, {
            kind: 'error',
            title: '모델을 내려받지 못했습니다',
            description: modelRef.current.message ?? undefined,
            progress: undefined,
            meta: undefined,
            duration: 8000,
            actions: [{ label: '다시 시도', primary: true, onClick: () => modelRef.current.retry() }],
          });
          return null;
        }
        toast.dismiss(MODEL_TOAST);
      }
    }
    const engine = selectEngine(modelRef.current.manifest);
    if (!engine) {
      toast.show({
        kind: 'error',
        title: '음성 인식을 시작할 수 없습니다',
        description: '설정에서 API 키를 넣거나 모델이 포함된 빌드가 필요합니다',
        duration: 8000,
        actions: [{ label: '설정 열기', primary: true, onClick: () => router.push('/settings') }],
      });
      return null;
    }
    setEngineKind(engine.kind);
    return engine;
  }, [toast, router]);

  const updateOnDeviceToast = useCallback(() => {
    const progress = onDeviceProgressRef.current;
    const total = Math.max(1, durationRef.current ?? progress.enqueuedMs);
    const percent = Math.min(100, Math.round(((progress.doneMs + progress.currentMs * progress.currentRatio) / total) * 100));
    toast.update(TRANSCRIBE_TOAST, { title: `인식 중 ${percent}%`, description: undefined, meta: undefined, progress: percent });
  }, [toast]);

  const makeQueue = useCallback(
    (engine: TranscribeEngine, onOutcome: (outcome: ChunkOutcome) => void): TranscribeQueue => {
      onDeviceProgressRef.current = { doneMs: 0, currentMs: 0, currentRatio: 0, enqueuedMs: 0, chunkMs: new Map() };
      const queue = createTranscribeQueue(
        { engine, maxRetries: 3 },
        {
          onOutcome: (outcome) => {
            if (engine.kind === 'ondevice') {
              const progress = onDeviceProgressRef.current;
              progress.doneMs += outcome.meta.endMs - outcome.meta.startMs;
              progress.currentMs = 0;
              progress.currentRatio = 0;
              updateOnDeviceToast();
            }
            onOutcome(outcome);
          },
          onFatal: failWith,
          onProgress:
            engine.kind === 'ondevice'
              ? (index, ratio) => {
                  const progress = onDeviceProgressRef.current;
                  progress.currentMs = progress.chunkMs.get(index) ?? 0;
                  progress.currentRatio = ratio;
                  updateOnDeviceToast();
                }
              : undefined,
        },
      );
      if (engine.kind !== 'ondevice') return queue;
      // 조각 길이를 알아야 진행률을 낼 수 있다 — enqueue 를 감싸 번호별 길이를 적어 둔다
      return {
        ...queue,
        enqueue: (chunk: AudioChunk) => {
          const progress = onDeviceProgressRef.current;
          progress.enqueuedMs += chunk.endMs - chunk.startMs;
          progress.chunkMs.set(chunk.index, chunk.endMs - chunk.startMs);
          queue.enqueue(chunk);
        },
      };
    },
    [failWith, updateOnDeviceToast],
  );

  /** 새 노트: 무음 분할 → 전 조각 인식 */
  const beginNew = useCallback(
    (selected: File, buffer: ArrayBuffer, sha256: string) => {
      void (async () => {
        const engine = await ensureEngine();
        if (!engine) return;
        stop();
        setMode('new');
        setActive(null);
        pendingAudioRef.current = null;
        pendingRetryRef.current = null;
        pendingIdRef.current = newProjectId();
        const id = pendingIdRef.current;
        setSource(selected);
        setTitle(stripExtension(selected.name));
        setOutcomes(new Map());
        setExpectedCount(null);
        setDurationMs(null);
        setSavedAt(null);
        setEditorValue(null);
        setDoc(null);
        setPhase('splitting');
        toast.show({ id: TRANSCRIBE_TOAST, kind: 'progress', title: '오디오를 나누는 중…', progress: 0 });

        const queue = makeQueue(engine, (outcome) =>
          setOutcomes((previous) => new Map(previous).set(outcome.meta.index, outcome)),
        );
        queueRef.current = queue;

        splitOptionsRef.current = engine.kind === 'ondevice' ? ON_DEVICE_SPLIT_OPTIONS : DEFAULT_SPLIT_OPTIONS;
        const handle = splitAudioBuffer(
          buffer,
          (chunk) => {
            setPhase((current) => (current === 'splitting' ? 'transcribing' : current));
            queue.enqueue(chunk);
          },
          splitOptionsRef.current,
        );
        splitRef.current = handle;

        handle.done
          .then((summary) => {
            setExpectedCount(summary.chunkCount);
            setDurationMs(summary.totalMs);
            pendingAudioRef.current = {
              kind: 'file',
              name: selected.name,
              size: selected.size,
              sha256,
              durationMs: summary.totalMs,
              mimeType: audioMime(selected),
            };
            // 원본을 브라우저에 남겨 두면 다음에 열 때 재생·재인식에 파일을 다시 고를 필요가 없다
            void putRecording({
              id,
              blob: selected,
              mimeType: audioMime(selected),
              durationMs: summary.totalMs,
              updatedAt: Date.now(),
            }).catch(() => {});
            return queue.close();
          })
          .catch(failWith);
      })();
    },
    [stop, setActive, setDoc, makeQueue, failWith, toast, ensureEngine],
  );

  /** 재인식: 저장된 시간 구간만 추출해 실패 조각만 다시 보낸다 */
  const beginRetry = useCallback(
    (extract: RangeExtractor, failed: StoredChunk[], project: Project) => {
      void (async () => {
        const engine = await ensureEngine();
        if (!engine) return;
        stop();
        setMode('retry');
        setRetryDone(0);
        setRetryTotal(failed.length);
        setPhase('transcribing');
        toast.show({
          id: RETRY_TOAST,
          kind: 'progress',
          title: `재인식 중 · 0/${failed.length}`,
          description: failed.length === 1 ? '실패했던 조각 하나만 다시 보냅니다' : `실패했던 ${failed.length}개 조각만 다시 보냅니다`,
          progress: 0,
        });

        let done = 0;
        const queue = makeQueue(engine, (outcome) => {
          done += 1;
          setRetryDone(done);
          toast.update(RETRY_TOAST, {
            title: `재인식 중 · ${done}/${failed.length}`,
            progress: (done / failed.length) * 100,
          });
          if (outcome.kind !== 'ok') return;
          const current = activeRef.current;
          const doc = docRef.current;
          if (!current || !doc) return;
          const { doc: patchedDoc, patched } = patchFailedParagraph(doc, outcome.meta.startMs, outcome.text);
          const chunks = current.chunks.map((chunk) =>
            chunk.index === outcome.meta.index ? { ...chunk, status: 'ok' as const } : chunk,
          );
          activeRef.current = { ...current, chunks };
          setActiveProject(activeRef.current);
          if (patched) {
            docRef.current = patchedDoc;
            setCurrentDoc(patchedDoc);
            setEditorValue(patchedDoc);
          }
        });
        queueRef.current = queue;

        const handle = extract(toExtractRanges(failed, project.chunks), (chunk) => queue.enqueue(chunk));
        splitRef.current = handle;

        handle.done
          .then((summary) => {
            const stored = project.audio?.durationMs;
            if (typeof stored === 'number' && Math.abs(summary.totalMs - stored) > 50) {
              console.warn(`[retry] 디코드 길이가 저장값과 다릅니다: stored=${stored}ms decoded=${summary.totalMs}ms`);
            }
            return queue.close();
          })
          .then(() => {
            const current = activeRef.current;
            let remaining = 0;
            if (current) {
              const updated: Project = { ...current, doc: docRef.current ?? current.doc, updatedAt: Date.now() };
              setActive(updated);
              persist(updated);
              remaining = failedChunksOf(updated).length;
            }
            setMode('new');
            setPhase('review');
            toast.update(RETRY_TOAST, {
              kind: remaining > 0 ? 'error' : 'success',
              title: remaining > 0 ? `재인식 끝 · 아직 실패 ${remaining}개` : '재인식 완료',
              description: remaining > 0 ? '잠시 후 새로고침을 다시 눌러 보세요.' : undefined,
              progress: undefined,
              duration: remaining > 0 ? 8000 : 4000,
            });
          })
          .catch(failWith);
      })();
    },
    [stop, makeQueue, setActive, persist, failWith, toast, ensureEngine],
  );

  /** 파일 선택: 같은 오디오면 재생 연결·부분 재인식, 다른 파일이면 새 노트 */
  const start = useCallback(
    (selected: File) => {
      void (async () => {
        const buffer = await selected.arrayBuffer();
        const sha256 = await sha256Hex(buffer); // transfer 전에 해시부터
        const active = activeRef.current;
        const pending = pendingRetryRef.current;
        pendingRetryRef.current = null;

        if (active?.audio && audioKindOf(active.audio) === 'file' && active.audio.sha256 === sha256) {
          setSource(selected);
          setDurationMs(active.audio.durationMs);
          void putRecording({
            id: active.id,
            blob: selected,
            mimeType: audioMime(selected),
            durationMs: active.audio.durationMs,
            updatedAt: Date.now(),
          }).catch(() => {});
          const allFailed = failedChunksOf(active);
          const failed = pending === null ? allFailed : allFailed.filter((chunk) => chunk.index === pending);
          if (failed.length > 0) {
            beginRetry((ranges, onChunk) => extractAudioRanges(buffer, ranges, onChunk), failed, active);
          } else {
            toast.show({
              kind: 'info',
              title: '같은 오디오를 연결했습니다',
              description: '모든 조각이 완료돼 재생만 연결됩니다.',
            });
          }
          return;
        }

        if (pending !== null) {
          toast.show({
            kind: 'error',
            title: '다른 파일입니다',
            description: '이 노트의 오디오와 내용이 다릅니다. 원본 파일을 선택하세요.',
          });
          return;
        }

        if (active) {
          const proceed = await dialog.confirm({
            title: '열려 있는 노트와 다른 파일입니다',
            description: '새 노트로 시작할까요? 지금 열린 노트는 그대로 남습니다.',
            confirmLabel: '새 노트로 시작',
          });
          if (!proceed) return;
        }
        beginNew(selected, buffer, sha256);
      })().catch(failWith);
    },
    [beginNew, beginRetry, failWith, toast, dialog],
  );

  /** 에디터의 실패 조각 새로고침: 오디오가 연결돼 있으면 바로, 아니면 파일 선택부터 */
  const retryChunk = useCallback(
    (startMs: number) => {
      const project = activeRef.current;
      if (!project) return;
      const chunk = project.chunks.find((c) => c.startMs === startMs && c.status === 'failed');
      if (!chunk) {
        toast.show({
          kind: 'error',
          title: '조각 정보를 찾을 수 없습니다',
          description: '오디오를 다시 불러오면 남은 실패 조각을 모두 재인식합니다.',
        });
        return;
      }
      const isRecording = audioKindOf(project.audio) === 'recording';
      const retryWith = (buffer: ArrayBuffer) => {
        if (isRecording) {
          const bytes = new Uint8Array(buffer);
          beginRetry((ranges, onChunk) => extractWavRanges(bytes, ranges, onChunk), [chunk], project);
        } else {
          beginRetry((ranges, onChunk) => extractAudioRanges(buffer, ranges, onChunk), [chunk], project);
        }
      };
      void getRecording(project.id)
        .then(async (stored) => {
          if (stored) {
            retryWith(await stored.blob.arrayBuffer());
            return;
          }
          if (source) {
            retryWith(await source.arrayBuffer());
            return;
          }
          if (isRecording) {
            toast.show({ kind: 'error', title: '녹음 파일을 찾을 수 없습니다', description: '이 브라우저에 저장된 녹음이 지워진 것 같습니다.' });
            return;
          }
          pendingRetryRef.current = chunk.index;
          toast.show({
            kind: 'info',
            title: '오디오를 먼저 불러오세요',
            description: '같은 파일을 선택하면 이 조각만 다시 인식합니다.',
          });
          sidebarRef.current?.openAudioPicker();
        })
        .catch(failWith);
    },
    [source, beginRetry, failWith, toast],
  );

  const resetWorkspace = useCallback(() => {
    stop();
    setActive(null);
    setSource(null);
    setTitle('');
    setOutcomes(new Map());
    setExpectedCount(null);
    setDurationMs(null);
    setSavedAt(null);
    setEditorValue(null);
    setDoc(null);
    setPhase('idle');
  }, [stop, setActive, setDoc]);

  const openProject = useCallback(
    (id: string) => {
      const project = loadProject(window.localStorage, id);
      if (!project) return;
      stop();
      pendingRetryRef.current = null;
      const doc = upgradeFailedPlaceholders(project.doc, failedChunksOf(project));
      setMode('new');
      setActive({ ...project, doc });
      setTitle(project.title);
      setEditorValue(doc);
      setDoc(doc);
      setOutcomes(new Map());
      setExpectedCount(project.chunks.length > 0 ? project.chunks.length : null);
      setDurationMs(project.audio?.durationMs ?? null);
      setSavedAt(project.updatedAt);
      setCurrentMs(0);
      setPhase('review');
      attachAudio({ ...project, doc });
    },
    [stop, setActive, setDoc, attachAudio],
  );

  const removeProject = useCallback(
    (id: string) => {
      void (async () => {
        const target = loadProject(window.localStorage, id);
        const hasAudio = audioKindOf(target?.audio) !== 'text';
        const name = target?.title.trim() || '(제목 없음)';
        const proceed = await dialog.confirm({
          kind: 'danger',
          title: '노트를 삭제할까요?',
          description: hasAudio ? `‘${name}’ 와 저장된 오디오 원본이 함께 지워집니다.` : `‘${name}’ 이(가) 지워집니다.`,
          warning: '이 작업은 되돌릴 수 없습니다.',
          confirmLabel: '삭제',
        });
        if (!proceed) return;
        deleteProject(window.localStorage, id);
      void deleteRecording(id).catch(() => {});
      void deleteRecordingParts(id).catch(() => {});
        refreshProjects();
        if (activeRef.current?.id === id) resetWorkspace();
        toast.show({ kind: 'info', title: '노트를 삭제했습니다' });
      })();
    },
    [refreshProjects, resetWorkspace, toast, dialog],
  );

  const renameProject = useCallback(
    (id: string, nextTitle: string) => {
      const project = loadProject(window.localStorage, id);
      if (!project) return;
      saveProject(window.localStorage, { ...project, title: nextTitle, updatedAt: Date.now() });
      refreshProjects();
      if (activeRef.current?.id === id) {
        setTitle(nextTitle);
        setActive({ ...activeRef.current, title: nextTitle });
      }
    },
    [refreshProjects, setActive],
  );

  const exportProject = useCallback((id: string) => {
    const project = loadProject(window.localStorage, id);
    if (!project) return;
    downloadBlob(
      new Blob([serializeProject(project)], { type: 'application/json' }),
      `${project.title.trim() || 'note'}.asr.json`,
    );
  }, []);

  const importProject = useCallback(
    (jsonFile: File) => {
      void (async () => {
        const text = await jsonFile.text();
        const project = parseProjectFile(text, Date.now());
        if (!project) {
          toast.show({
            kind: 'error',
            title: '불러올 수 없는 파일입니다',
            description: '이 앱에서 내보낸 .asr.json 파일인지 확인하세요.',
          });
          return;
        }
        saveProject(window.localStorage, project);
        refreshProjects();
        openProject(project.id);
        toast.show({ kind: 'success', title: '노트를 불러왔습니다', description: project.title });
      })().catch(failWith);
    },
    [refreshProjects, openProject, failWith, toast],
  );

  const live = useLiveRecording({
    // 스트리밍 녹음은 조각 단위 큐를 쓰지 않는다 — 세그먼트가 outcomes 에 바로 들어간다
    onChunk: (chunk) => {
      const recognizer = liveRecognizerRef.current;
      if (recognizer) recognizer.endTurn?.(chunk);
      else queueRef.current?.enqueue(chunk);
    },
    onSkipped: (meta: ChunkMeta) => {
      const recognizer = liveRecognizerRef.current;
      if (recognizer) recognizer.endTurn?.(meta);
      else setOutcomes((previous) => new Map(previous).set(meta.index, { kind: 'ok', meta, text: '' }));
    },
    onFrame: (frame) => {
      const recognizer = liveRecognizerRef.current;
      if (!recognizer) return;
      liveSentMsRef.current += (frame.length / 16000) * 1000;
      recognizer.push(frame);
    },
    onStoreError: (error) =>
      toast.show({ kind: 'error', title: '녹음 조각을 저장하지 못했습니다', description: error.message }),
  });

  /** 새 노트북: 오디오 없는 빈 노트를 만들어 바로 편집 상태로 연다 */
  const createBlankNote = useCallback(() => {
    if (phase === 'splitting' || phase === 'transcribing' || phase === 'recording') return;
    stop();
    const now = Date.now();
    const project: Project = {
      id: newProjectId(),
      title: `노트 ${formatDateTime(now)}`,
      createdAt: now,
      updatedAt: now,
      audio: null,
      splitOptions: null,
      chunks: [],
      doc: EMPTY_DOC,
    };
    setMode('new');
    setActive(project);
    persist(project);
    pendingAudioRef.current = null;
    pendingRetryRef.current = null;
    setSource(null);
    setTitle(project.title);
    setOutcomes(new Map());
    setExpectedCount(null);
    setDurationMs(null);
    setEditorValue(EMPTY_DOC);
    setDoc(EMPTY_DOC);
    setCurrentMs(0);
    setPhase('review');
  }, [phase, stop, setActive, persist, setDoc]);

  /** 녹음 시작: 엔진을 확보하고(On-Device 면 sherpa 워커까지 띄운 뒤) 빈 녹음 노트를 만들고 마이크를 연다 (권한 거부 시 노트는 지운다) */
  const startRecording = useCallback(() => {
    if (phase === 'splitting' || phase === 'transcribing' || phase === 'recording') return;
    void (async () => {
      const engine = await ensureEngine();
      if (!engine) return;
      stop();
      setLivePartial('');
      setLiveLagMs(0);
      liveIndexRef.current = 0;
      liveSentMsRef.current = 0;
      const handlers: LiveRecognizerHandlers = {
        onPartial: (text, processedMs) => {
          setLivePartial(text);
          setLiveLagMs(liveSentMsRef.current - processedMs);
        },
        onFinal: (segment) => {
          const index = liveIndexRef.current;
          liveIndexRef.current += 1;
          const meta: ChunkMeta = { index, startMs: segment.startMs, endMs: segment.endMs };
          setOutcomes((previous) => new Map(previous).set(index, { kind: 'ok', meta, text: segment.text }));
        },
        onRestart: () => setLiveRestarting(true),
        onError: (error) =>
          toast.show({ kind: 'error', title: '실시간 인식이 멈췄습니다', description: `${error.message} · 녹음은 계속 저장됩니다` }),
      };
      // 스트리밍 엔진: On-Device 는 sherpa, BYOK 는 Realtime 전용 모델. 그 밖의 BYOK 는 조각 단위 큐로 보낸다
      const settings = readByokSettings();
      const manifest = modelRef.current.manifest;
      if (engine.kind === 'ondevice' && !manifest) return;
      const startStreaming =
        engine.kind === 'ondevice' && manifest
          ? () => startLiveRecognizer(manifest, handlers)
          : engine.kind === 'byok' && isRealtimeTarget(settings)
            ? () => startRealtimeRecognizer({ ...settings, language: ASR_LANGUAGE }, handlers)
            : null;
      setStreamingLive(startStreaming !== null);
      if (startStreaming) {
        try {
          liveRecognizerRef.current = await startStreaming();
        } catch (error) {
          setStreamingLive(false);
          const message = error instanceof Error ? error.message : String(error);
          toast.show({
            kind: 'error',
            title: '실시간 인식 엔진을 시작할 수 없습니다',
            description: message,
            actions: message.includes('다시 내려받아야') ? [{ label: '다시 받기', primary: true, onClick: () => modelRef.current.start() }] : undefined,
          });
          return;
        }
      }
      const now = Date.now();
      const id = newProjectId();
      const noteTitle = `녹음 ${formatDateTime(now)}`;
      const audio: ProjectAudio = {
        kind: 'recording',
        name: `${noteTitle}.wav`,
        size: 0,
        sha256: '',
        durationMs: 0,
        mimeType: 'audio/wav',
      };
      const project: Project = { id, title: noteTitle, createdAt: now, updatedAt: now, audio, splitOptions: null, chunks: [], doc: EMPTY_DOC };
      setMode('new');
      setActive(project);
      persist(project);
      pendingAudioRef.current = audio;
      pendingRetryRef.current = null;
      setSource(null);
      setTitle(noteTitle);
      setOutcomes(new Map());
      setExpectedCount(null);
      setDurationMs(null);
      setEditorValue(EMPTY_DOC);
      setDoc(EMPTY_DOC);
      setCurrentMs(0);
      queueRef.current = liveRecognizerRef.current
        ? null
        : makeQueue(engine, (outcome) => setOutcomes((previous) => new Map(previous).set(outcome.meta.index, outcome)));
      setPhase('recording');
      live.start(id).catch((error: unknown) => {
        stop();
        deleteProject(window.localStorage, id);
        resetWorkspace();
        refreshProjects();
        toast.show({
          kind: 'error',
          title: '마이크를 시작할 수 없습니다',
          description: error instanceof Error ? error.message : String(error),
        });
      });
    })();
  }, [phase, stop, setActive, persist, setDoc, makeQueue, live, resetWorkspace, refreshProjects, toast, ensureEngine]);

  /** 녹음 중지: 마지막 조각까지 보내고, WAV 를 저장한 뒤 남은 인식이 끝나면 완료 효과가 노트를 확정한다 */
  const stopRecording = useCallback(() => {
    if (stoppingRef.current || phase !== 'recording') return;
    stoppingRef.current = true;
    toast.show({ id: TRANSCRIBE_TOAST, kind: 'progress', title: '녹음을 마무리하는 중…', progress: 0 });
    live
      .stop()
      .then(async (result) => {
        const audio = pendingAudioRef.current;
        pendingAudioRef.current = audio ? { ...audio, durationMs: result.durationMs, size: result.blob.size } : audio;
        setSource(result.blob);
        setDurationMs(result.durationMs);
        durationRef.current = result.durationMs;
        const recognizer = liveRecognizerRef.current;
        if (recognizer) {
          // 마지막 세그먼트(finish 중 final)가 들어온 뒤에 기대 개수를 정한다
          await recognizer.finish();
          liveRecognizerRef.current = null;
          setStreamingLive(false);
          setLivePartial('');
          setExpectedCount(liveIndexRef.current);
        } else {
          setExpectedCount(result.chunkCount);
        }
        setPhase('transcribing');
        void queueRef.current?.close();
      })
      .catch(failWith)
      .finally(() => {
        stoppingRef.current = false;
      });
  }, [phase, live, failWith, toast]);

  // 녹음 중 자동 저장: 조각 결과가 올 때마다(1초 디바운스) 본문·조각·길이를 노트에 반영한다
  useEffect(() => {
    if (phase !== 'recording') return;
    const timer = setTimeout(() => {
      const active = activeRef.current;
      if (!active) return;
      const updated: Project = {
        ...active,
        title,
        doc: docRef.current ?? active.doc,
        chunks: outcomesToChunks(outcomes),
        audio: active.audio ? { ...active.audio, durationMs: live.emittedMs } : active.audio,
        updatedAt: Date.now(),
      };
      activeRef.current = updated;
      setActiveProject(updated);
      persist(updated);
    }, 1000);
    return () => clearTimeout(timer);
  }, [phase, outcomes, title, live.emittedMs, persist]);

  const downloadAudio = useCallback(
    (id: string) => {
      const project = loadProject(window.localStorage, id);
      void getRecording(id)
        .then((stored) => {
          if (!stored) {
            toast.show({
              kind: 'error',
              title: '오디오 파일을 찾을 수 없습니다',
              description: '이 브라우저에 원본이 없습니다. 오디오를 다시 불러오면 저장됩니다.',
            });
            return;
          }
          const isRecording = audioKindOf(project?.audio) === 'recording';
          const filename = isRecording
            ? `${project?.title.trim() || 'recording'}.wav`
            : project?.audio?.name || `${project?.title.trim() || 'audio'}.mp3`;
          downloadBlob(stored.blob, filename);
          toast.show({
            kind: 'success',
            title: '오디오 파일 저장',
            description: `${filename} · ${(stored.blob.size / (1024 * 1024)).toFixed(1)}MB`,
          });
        })
        .catch(failWith);
    },
    [failWith, toast],
  );

  const exportDoc = useCallback(
    async (format: ExportFormat, docTitle: string, doc: TiptapDoc, layout: PageLayout) => {
      try {
        const response = await fetch('/api/export', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ format, title: docTitle, doc, layout }),
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `내보내기 실패 (${response.status})`);
        }
        const blob = await response.blob();
        const filename = `${docTitle.trim() || 'transcript'}.${format}`;
        downloadBlob(blob, filename);
        toast.show({
          kind: 'success',
          title: `${format.toUpperCase()} 저장 완료`,
          description: `${filename} · ${Math.max(1, Math.round(blob.size / 1024))}KB`,
        });
      } catch (error) {
        toast.show({
          kind: 'error',
          title: '문서를 만들지 못했습니다',
          description: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [toast],
  );

  /** 노트의 문서 레이아웃 — 저장된 값이 없거나 옛 형식이면 기본값으로 메운다 */
  const layout = useMemo(() => normalizePageLayout(activeProject?.layout), [activeProject?.layout]);

  /** 레이아웃 패널의 변경은 바로 노트에 저장된다 */
  const updateLayout = useCallback(
    (next: PageLayout) => {
      const active = activeRef.current;
      if (!active) return;
      const updated: Project = { ...active, layout: next, updatedAt: Date.now() };
      setActive(updated);
      persist(updated);
    },
    [setActive, persist],
  );

  /** 상단 바: 지금 편집 중인 문서 */
  const exportDocument = async (format: ExportFormat) => {
    if (!currentDoc) return;
    await exportDoc(format, title, currentDoc, layout);
  };

  /** 노트 메뉴: 열려 있는 노트면 편집 중인 문서, 아니면 저장된 문서 */
  const exportProjectDoc = useCallback(
    (id: string, format: ExportFormat) => {
      if (activeRef.current?.id === id && docRef.current) {
        void exportDoc(format, title, docRef.current, layout);
        return;
      }
      const project = loadProject(window.localStorage, id);
      if (project) void exportDoc(format, project.title, project.doc, normalizePageLayout(project.layout));
    },
    [exportDoc, title, layout],
  );

  const recording = phase === 'recording';
  const busy = phase === 'splitting' || phase === 'transcribing' || recording;
  const topStatus = recording
    ? `녹음 중 · ${formatTimestamp(live.elapsedMs)}`
    : phase === 'splitting'
      ? '오디오를 나누는 중…'
      : phase === 'transcribing'
        ? mode === 'retry'
          ? `재인식 ${retryDone}/${retryTotal}`
          : `인식 ${assembled.readyCount}/${expectedCount ?? '…'}`
        : null;
  const editorStatus = phase === 'review' ? '검수 중' : recording ? '녹음 중 · 편집 잠금' : busy ? '인식 중 · 편집 잠금' : '대기';
  const showEditor = editorValue !== null || phase !== 'idle';
  const pendingChunks = Math.max(0, live.chunkCount - outcomes.size);
  const liveRow = recording
    ? {
        startMs: live.emittedMs,
        partial: streamingLive && live.status !== 'paused' ? livePartial : undefined,
        label:
          live.status === 'paused'
            ? '일시정지'
            : liveRestarting
              ? '인식 엔진 재시작'
              : streamingLive
                ? liveLagMs > 3000
                  ? '처리 지연'
                  : '듣는 중'
                : pendingChunks > 0
                  ? `인식 중 · 대기 ${pendingChunks}`
                  : '듣는 중',
      }
    : null;

  return (
    <div className={styles.shell}>
      <TopBar title={title} titleVisible={activeProject !== null || busy} onTitleChange={setTitle} />

      <div className={styles.frame}>
        <Sidebar
          ref={sidebarRef}
          projects={projects}
          activeId={activeProject?.id ?? null}
          disabled={busy}
          recording={recording}
          onSelectAudio={start}
          onImport={importProject}
          onToggleRecord={recording ? stopRecording : startRecording}
          onNewNote={createBlankNote}
          onOpen={openProject}
          onRename={renameProject}
          onExportJson={exportProject}
          onExportDoc={exportProjectDoc}
          onDownloadAudio={downloadAudio}
          onDelete={removeProject}
        />

        <TabRow savedAt={phase === 'review' ? savedAt : null} exportDisabled={phase !== 'review' || !currentDoc} onExport={exportDocument} />

        <div className={styles.sheet}>
          <main className={styles.main}>
            <div className={styles.editorColumn}>
              {showEditor ? (
                <Editor
                  value={editorValue}
                  editable={phase === 'review'}
                  showTimestamps={showTimestamps}
                  currentMs={currentMs}
                  statusLabel={topStatus ?? editorStatus}
                  onChange={setDoc}
                  onSeek={(ms) => playerRef.current?.seekTo(ms)}
                  onRetryChunk={retryChunk}
                  onToggleTimestamps={() => setShowTimestamps((v) => !v)}
                  live={liveRow}
                  layoutOpen={layoutOpen}
                  layoutDisabled={!activeProject}
                  onToggleLayout={() => setLayoutOpen((open) => !open)}
                />
              ) : (
                <div className={styles.empty}>
                  <span className={styles.emptyTitle}>오디오를 불러오거나 녹음을 시작하세요</span>
                  <span>오디오를 선택하거나 마이크로 녹음하면 인식이 시작되고, 결과는 이 브라우저에 노트로 저장됩니다.</span>
                </div>
              )}
            </div>
            <LayoutPanel
              open={layoutOpen && activeProject !== null && showEditor}
              layout={layout}
              onChange={updateLayout}
              onClose={() => setLayoutOpen(false)}
            />
          </main>

          {recording ? (
            <RecordingBar
              elapsedMs={live.elapsedMs}
              paused={live.status === 'paused'}
              levelsRef={live.levelsRef}
              onPause={live.pause}
              onResume={live.resume}
              onStop={stopRecording}
            />
          ) : (
            <PlayerBar ref={playerRef} source={source} durationMs={durationMs} onTimeUpdate={setCurrentMs} />
          )}
        </div>
      </div>
    </div>
  );
};