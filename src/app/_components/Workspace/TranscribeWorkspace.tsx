'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { assembleTranscript, type ChunkMeta, type ChunkOutcome, type TranscriptBlock } from '@/app/_lib/asr/assembleTranscript';
import { MIN_DIARIZE_MS, diarizeAudio, speakerRuntimeOf } from '@/app/_lib/diarization/diarize';
import type { SpeakerTurn } from '@/app/_lib/diarization/speakerTurns';
import type { EngineKind, TranscribeEngine } from '@/app/_lib/asr/asrEngine';
import { selectEngine } from '@/app/_lib/asr/selectEngine';
import { createTranscribeQueue, type TranscribeQueue } from '@/app/_lib/asr/transcribeQueue';
import { sha256Hex } from '@/app/_lib/audio/fileHash';
import { deleteRecording, deleteRecordingParts, getRecording, putRecording } from '@/app/_lib/audio/recordingStore';
import { extractAudioRanges, splitAudioBuffer, type SplitHandle } from '@/app/_lib/audio/splitAudioFile';
import { DEFAULT_SPLIT_OPTIONS, DIARIZED_SPLIT_OPTIONS, ON_DEVICE_SPLIT_OPTIONS, type AudioChunk, type ExtractRange, type SplitOptions } from '@/app/_lib/audio/types';
import { extractWavRanges, wavsToPcm16 } from '@/app/_lib/audio/wav';
import { blocksToTiptapDoc, partHeadingNode, type BlockLanguages } from '@/app/_lib/editor/blocksToTiptapDoc';
import { patchFailedParagraph, upgradeFailedPlaceholders } from '@/app/_lib/editor/patchTranscript';
import {
  audioKindOf,
  deleteProject,
  listProjects,
  loadProject,
  migrateLegacyDraft,
  newProjectId,
  noteDurationOf,
  notePartsOf,
  parseProjectFile,
  partIndexAt,
  partStorageKey,
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
import { startWhisperLive, whisperBackend, type LiveRecognizer, type LiveRecognizerHandlers } from '@/app/_lib/engine/malsaegimEngine';
import { ASR_LANGUAGE, isRealtimeTarget } from '@/app/_lib/asr/directTranscribe';
import { startRealtimeRecognizer } from '@/app/_lib/asr/realtimeRecognizer';
import { isByokComplete, readByokSettings } from '@/app/_lib/settings/byokSettings';
import { readTranslationSettings, resolveTranslationKey, writeTranslationSettings } from '@/app/_lib/settings/translationSettings';
import { readWorkspaceState, tabOfMeta, writeWorkspaceState, type WorkspaceTab } from '@/app/_lib/settings/workspaceState';
import type { TiptapDoc, TiptapNode } from '@/app/_lib/hwp/tiptapToDocModel';
import { AUTO_SOURCE, pairLabel } from '@/app/_lib/translation/languages';
import { speakerView, type SpeakerState } from '@/app/_lib/translation/speaker';
import {
  classifyStartError,
  startTranslationRecognizer,
  type TranslationHandlers,
  type TranslationRecognizer,
  type TranslationStatus,
} from '@/app/_lib/translation/translationRecognizer';
import { formatDateTime, formatTimestamp } from '@/app/_lib/time';
import { Editor } from '../Editor/Editor';
import { LayoutPanel } from '../LayoutPanel/LayoutPanel';
import { useModelDownload } from '../OnDevice/ModelProvider';
import { NewTranslationDialog, type TranslationChoice } from '../Translation/NewTranslationDialog';
import { TranslationBanner } from '../Translation/TranslationBanner';
import { TranslationLiveView } from '../Translation/TranslationLiveView';
import { TranslationNotice, supportsTranslation } from '../Translation/TranslationNotice';
import { PlayerBar, type PlayerBarHandle, type PlayerTrack } from '../PlayerBar/PlayerBar';
import { RecordingBar } from '../RecordingBar/RecordingBar';
import { useDialog } from '../Dialog/DialogProvider';
import { useToast } from '../Toast/ToastProvider';
import { Sidebar, type SidebarHandle } from './Sidebar';
import { SidebarDrawer } from './SidebarDrawer';
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

type TranslationSession = {
  status: TranslationStatus;
  delayed: boolean;
  speaker: SpeakerState;
  partial: { source: string; translation: string };
  sourceLanguage: string;
  targetLanguage: string;
  /** 일시정지를 누른 시각 */
  pausedAtMs: number | null;
  /** 번역 없이 녹음 계속을 골랐다 */
  bannerDismissed: boolean;
  /** 마이크가 끊겼다 */
  micLost: boolean;
};

type NewTranslationState = { choice: TranslationChoice; focus: 'source' | 'start' };
type NoticeKind = 'key' | 'unsupported';

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

const blockLanguagesOf = (project: Project | null): BlockLanguages | undefined =>
  project?.translation
    ? {
        source: project.translation.sourceLanguage === AUTO_SOURCE ? null : project.translation.sourceLanguage,
        target: project.translation.targetLanguage,
      }
    : undefined;

/** 열린 노트에 이어 붙이는 인식 한 회차 — 새 파트의 시작 시각·조각 번호·원본 키와, 앞 내용 + 구분 제목까지의 문서 */
type AppendTarget = {
  base: Project;
  baseDoc: TiptapDoc;
  offsetMs: number;
  indexBase: number;
  partIndex: number;
  key: string;
};

const isBlankParagraph = (node: TiptapNode | undefined): boolean =>
  node?.type === 'paragraph' && (node.content ?? []).every((child) => child.type === 'text' && !(child.text ?? '').trim());

/** 이어 붙이기 준비 — 노트 끝에 "Part N · 라벨" 제목을 달고, 처음 이어 붙이는 오디오 노트면 맨 위에 Part 1 제목도 단다 */
const prepareAppend = (base: Project, label: string): AppendTarget => {
  const parts = notePartsOf(base);
  const partIndex = parts.length;
  const content = [...(base.doc.content ?? [])];
  while (content.length > 0 && isBlankParagraph(content[content.length - 1])) content.pop();
  if (partIndex === 1 && content[0]?.type !== 'heading') content.unshift(partHeadingNode(1, stripExtension(parts[0].name)));
  if (partIndex > 0 || content.length > 0) content.push(partHeadingNode(partIndex + 1, label));
  return {
    base,
    baseDoc: { type: 'doc', content },
    offsetMs: noteDurationOf(base),
    indexBase: base.chunks.reduce((max, chunk) => Math.max(max, chunk.index + 1), 0),
    partIndex,
    key: partStorageKey(base.id, partIndex),
  };
};

/** 앞 내용 + 이번 파트 인식 결과. 파트 안 시각에 시작 시각을 더해 노트 시간축으로 적는다 */
const composeAppendDoc = (target: AppendTarget, blocks: TranscriptBlock[], languages?: BlockLanguages): TiptapDoc => {
  const added = blocks.length > 0 ? (blocksToTiptapDoc(blocks, languages, target.offsetMs).content ?? []) : [];
  const content = [...(target.baseDoc.content ?? []), ...added];
  return { type: 'doc', content: content.length > 0 ? content : [{ type: 'paragraph' }] };
};

const shiftChunks = (target: AppendTarget, chunks: StoredChunk[]): StoredChunk[] =>
  chunks.map((chunk) => ({
    ...chunk,
    index: chunk.index + target.indexBase,
    startMs: chunk.startMs + target.offsetMs,
    endMs: chunk.endMs + target.offsetMs,
  }));

/** 이어 붙인 결과 노트 — 파트가 하나뿐이면(빈 노트에 처음 붙임) 예전 노트와 같은 모양으로 둔다 */
const appendedProject = (
  target: AppendTarget,
  audio: ProjectAudio,
  chunks: StoredChunk[],
  doc: TiptapDoc,
  title: string,
  now: number,
): Project => {
  const parts = [...notePartsOf(target.base), { ...audio, offsetMs: target.offsetMs }];
  return {
    ...target.base,
    title,
    updatedAt: now,
    audio: target.base.audio ?? audio,
    parts: parts.length > 1 ? parts : undefined,
    splitOptions: target.base.splitOptions,
    chunks: [...target.base.chunks, ...shiftChunks(target, chunks)],
    doc,
  };
};

type TracksState = { list: PlayerTrack[]; version: number };
/** 플레이어 파트 목록을 바꾼다 — version 이 바뀌어 플레이어가 처음부터 다시 뜬다 */
const nextTracks =
  (list: PlayerTrack[]) =>
  (previous: TracksState): TracksState => ({ list, version: previous.version + 1 });
const singleTrack = (blob: Blob | null): PlayerTrack[] => (blob ? [{ blob, offsetMs: 0, durationMs: 0 }] : []);

const noop = () => {};

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
  /** 이번 녹음이 스트리밍(On-Device whisper·Realtime) 경로인지 — 렌더에서 ref 를 읽지 않으려고 상태로 둔다 */
  const [streamingLive, setStreamingLive] = useState(false);
  const liveRecognizerRef = useRef<LiveRecognizer | null>(null);
  /** On-Device 녹음의 확정 세그먼트 번호 — 조각 번호와 무관하게 0부터 */
  const liveIndexRef = useRef(0);
  /** 엔진으로 보낸 오디오 시각 — 워커가 처리한 시각과의 차이가 지연 */
  const liveSentMsRef = useRef(0);

  const [phase, setPhase] = useState<Phase>('idle');
  const [mode, setMode] = useState<RunMode>('new');
  /** 플레이어가 재생할 오디오 파트들 — 이어 붙인 노트는 여러 개를 하나처럼 이어 재생한다 */
  const [tracksState, setTracksState] = useState<TracksState>({ list: [], version: 0 });
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
  const [showSource, setShowSource] = useState(true);
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [retryDone, setRetryDone] = useState(0);
  const [retryTotal, setRetryTotal] = useState(0);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [layoutOpen, setLayoutOpen] = useState(false);
  const [tab, setTab] = useState<WorkspaceTab>('transcribe');
  /** 첫 진입에서 저장된 탭을 읽기 전에는 탭 상태를 저장하지 않는다 */
  const [hydrated, setHydrated] = useState(false);
  /** 저장하고 이동을 고른 뒤 저장이 끝나면 옮겨 갈 탭 */
  const pendingTabRef = useRef<WorkspaceTab | null>(null);
  const [translation, setTranslation] = useState<TranslationSession | null>(null);
  const translationRef = useRef<TranslationRecognizer | null>(null);
  /** 연결 중 취소용 */
  const translationAbortRef = useRef<AbortController | null>(null);
  const [newTranslation, setNewTranslation] = useState<NewTranslationState | null>(null);
  const [notice, setNotice] = useState<NoticeKind | null>(null);
  /** 번역 탭 빈 화면을 키 안내로 덮을지 */
  const [emptyNotice, setEmptyNotice] = useState<NoticeKind | null>(null);
  const [micLabel, setMicLabel] = useState('기본 마이크');
  const [pendingRow, setPendingRow] = useState<{ title: string; meta: string } | null>(null);
  const [speakerHint, setSpeakerHint] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const menuReturnRef = useRef<HTMLElement | null>(null);

  const playerRef = useRef<PlayerBarHandle>(null);
  const sidebarRef = useRef<SidebarHandle>(null);
  const splitRef = useRef<SplitHandle | null>(null);
  const queueRef = useRef<TranscribeQueue | null>(null);
  const docRef = useRef<TiptapDoc | null>(null);
  const activeRef = useRef<Project | null>(null);
  const pendingAudioRef = useRef<ProjectAudio | null>(null);
  /** 열린 노트에 이어 붙이는 중이면 그 대상 (새 노트면 null) */
  const appendRef = useRef<AppendTarget | null>(null);
  const pendingRetryRef = useRef<number | null>(null);
  /** 새 파일 노트의 id — 원본 Blob 을 인식이 끝나기 전에 IndexedDB 에 넣어야 해서 미리 정한다 */
  const pendingIdRef = useRef<string | null>(null);
  const stoppingRef = useRef(false);
  const stopRecordingRef = useRef<() => void>(() => {});
  /** 이번 새 노트 인식에 쓴 분할 옵션 — 엔진에 따라 다르다 (노트에 참고용으로 저장) */
  const splitOptionsRef = useRef<SplitOptions>(DEFAULT_SPLIT_OPTIONS);

  /** 이어 붙이는 중인 파트의 종류 — 문단 합치기를 첫 파트가 아니라 이번 파트 기준으로 정한다 */
  const [appendKind, setAppendKind] = useState<'file' | 'recording' | null>(null);
  // 녹음 노트는 조각이 짧아(문장 쉼마다) 25초 안쪽의 연속 조각을 한 문단으로 합친다
  const liveNote = (appendKind ?? audioKindOf(activeProject?.audio)) === 'recording';
  // 화자 구분 결과 — null 이면 아직 없거나 건너뛴다. 받으면 조립이 말 차례대로 문단을 나눈다
  const [speakerTurns, setSpeakerTurns] = useState<SpeakerTurn[] | null>(null);
  const assembled = useMemo(
    () => assembleTranscript(outcomes, expectedCount, liveNote ? LIVE_PARAGRAPH_MS : null, speakerTurns),
    [outcomes, expectedCount, liveNote, speakerTurns],
  );

  /** 받아쓰기가 끝나면 화자 구분에 넘길 오디오 — 조각을 잇는 비용 때문에 그때 만든다 */
  const speakerAudioRef = useRef<(() => Int16Array) | null>(null);
  const diarizeAbortRef = useRef<AbortController | null>(null);
  const [diarizing, setDiarizing] = useState(false);

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

  /** IndexedDB 에 남아 있는 원본(녹음 WAV 또는 불러온 파일)을 플레이어·재인식 소스로 붙인다. 이어 붙인 파트는 모두 */
  const attachAudio = useCallback((project: Project) => {
    setTracksState(nextTracks([]));
    const parts = notePartsOf(project);
    if (parts.length === 0) return;
    void Promise.all(
      parts.map((part, index) =>
        getRecording(partStorageKey(project.id, index)).then((recording): PlayerTrack | null =>
          recording ? { blob: recording.blob, offsetMs: part.offsetMs, durationMs: part.durationMs } : null,
        ),
      ),
    )
      .then((loaded) => {
        if (activeRef.current?.id !== project.id) return;
        setTracksState(nextTracks(loaded.filter((track): track is PlayerTrack => track !== null)));
      })
      .catch(() => {});
  }, []);

  /** 화자 구분 — 실패해도 받아쓰기 결과는 그대로 저장한다 */
  const runDiarization = useCallback(
    (audio: () => Int16Array) => {
      const runtime = speakerRuntimeOf(modelRef.current.manifest);
      const pcm = audio();
      if (!runtime || (pcm.length / 16000) * 1000 < MIN_DIARIZE_MS) {
        setDiarizing(false);
        return;
      }
      const controller = new AbortController();
      diarizeAbortRef.current = controller;
      toast.update(TRANSCRIBE_TOAST, { title: '화자 구분 중…', description: undefined, progress: 0, meta: undefined });
      diarizeAudio(
        pcm,
        runtime,
        (ratio) => toast.update(TRANSCRIBE_TOAST, { title: '화자 구분 중…', progress: ratio * 100, meta: `${Math.round(ratio * 100)}%` }),
        controller.signal,
      )
        .then((turns) => {
          if (controller.signal.aborted) return;
          setSpeakerTurns(turns);
          setDiarizing(false);
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          console.warn('[diarize]', error);
          setDiarizing(false);
          toast.show({ kind: 'info', title: '화자를 구분하지 못했습니다', description: '받아쓰기는 화자 표시 없이 저장합니다' });
        });
    },
    [toast],
  );

  // 조립 결과 → 에디터 + 진행 토스트 (새 인식 중에만)
  useEffect(() => {
    if (mode !== 'new' || (phase !== 'transcribing' && phase !== 'splitting' && phase !== 'recording')) return;
    const append = appendRef.current;
    const doc = append
      ? composeAppendDoc(append, assembled.blocks, blockLanguagesOf(activeRef.current))
      : blocksToTiptapDoc(assembled.blocks, blockLanguagesOf(activeRef.current));
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
    // 화자 구분이 남아 있으면 먼저 끝낸다 — 결과가 들어오면 조립이 다시 돌고 이 효과가 다시 온다
    const speakerAudio = speakerAudioRef.current;
    if (speakerAudio) {
      speakerAudioRef.current = null;
      setDiarizing(true);
      runDiarization(speakerAudio);
      return;
    }
    if (diarizing) return;
    const append = appendRef.current;
    const doc =
      docRef.current ??
      (append
        ? composeAppendDoc(append, assembled.blocks, blockLanguagesOf(activeRef.current))
        : blocksToTiptapDoc(assembled.blocks, blockLanguagesOf(activeRef.current)));
    const chunks = outcomesToChunks(outcomes);
    const now = Date.now();
    const audio = pendingAudioRef.current;
    const isRecording = audioKindOf(audio) === 'recording';
    const project: Project =
      append && audio
        ? appendedProject(append, audio, chunks, doc, title, now)
        : {
            id: activeRef.current?.id ?? pendingIdRef.current ?? newProjectId(),
            title,
            createdAt: activeRef.current?.createdAt ?? now,
            updatedAt: now,
            audio,
            splitOptions: isRecording ? null : splitOptionsRef.current,
            chunks,
            doc,
            translation: activeRef.current?.translation,
          };
    appendRef.current = null;
    setActive(project);
    persist(project);
    setPhase('review');
    setAppendKind(null);
    // 이어 붙인 노트는 모든 파트를 다시 붙여 하나처럼 이어 재생한다
    if (append) attachAudio(project);
    if (project.translation) {
      toast.show({
        id: TRANSCRIBE_TOAST,
        kind: 'success',
        title: `번역 저장됨 · ${formatTimestamp(audio?.durationMs ?? 0)}`,
        description: '이 브라우저에 저장됨',
        duration: 4000,
      });
      return;
    }
    const failed = chunks.filter((chunk) => chunk.status === 'failed').length;
    const failedHint = '실패한 조각 옆 새로고침을 누르면 그 구간만 다시 인식합니다.';
    toast.update(TRANSCRIBE_TOAST, {
      kind: failed > 0 ? 'error' : 'success',
      title: append
        ? `Part ${append.partIndex + 1} 이어 붙임 · ${formatTimestamp(audio?.durationMs ?? 0)}${failed > 0 ? ` · 실패 ${failed}개` : ''}`
        : isRecording
        ? `녹음 저장됨 · ${formatTimestamp(audio?.durationMs ?? 0)}${failed > 0 ? ` · 실패 ${failed}개` : ''}`
        : failed > 0
          ? `인식 완료 · 실패 ${failed}개`
          : '인식 완료',
      description: failed > 0 ? failedHint : isRecording ? `${chunks.length}개 조각 · 이 브라우저에 저장됨` : `${chunks.length}개 조각`,
      progress: undefined,
      meta: undefined,
      duration: failed > 0 ? 8000 : 4000,
    });
  }, [mode, phase, assembled, outcomes, title, setActive, persist, toast, attachAudio, diarizing, runDiarization]);

  // 최초 진입: 예전 단일 초안 마이그레이션 + 목록 로드 + 최근 노트 자동 열기
  useEffect(() => {
    migrateLegacyDraft(window.localStorage);
    const metas = listProjects(window.localStorage);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setProjects(metas);
    const workspace = readWorkspaceState();
    setTab(workspace.tab);
    setHydrated(true);
    const inTab = metas.filter((meta) => tabOfMeta(meta) === workspace.tab);
    const lastId = workspace.lastNote[workspace.tab];
    const target = inTab.find((meta) => meta.id === lastId) ?? inTab[0];
    if (target) {
      const recent = loadProject(window.localStorage, target.id);
      if (recent) {
        const doc = upgradeFailedPlaceholders(recent.doc, failedChunksOf(recent));
        setActive({ ...recent, doc });
        setTitle(recent.title);
        setEditorValue(doc);
        setDoc(doc);
        setDurationMs(recent.audio ? noteDurationOf(recent) : null);
        setExpectedCount(recent.chunks.length > 0 ? recent.chunks.length : null);
        setSavedAt(recent.updatedAt);
        setPhase('review');
        attachAudio(recent);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 탭과 탭별 마지막 노트를 기억한다 — 진행 중 이동이 없으므로 열린 노트는 언제나 현재 탭의 노트다
  useEffect(() => {
    if (!hydrated) return;
    const state = readWorkspaceState();
    const id = activeProject?.id;
    writeWorkspaceState({ tab, lastNote: id ? { ...state.lastNote, [tab]: id } : state.lastNote });
  }, [hydrated, tab, activeProject?.id]);

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
    appendRef.current = null;
    setAppendKind(null);
    speakerAudioRef.current = null;
    diarizeAbortRef.current?.abort();
    diarizeAbortRef.current = null;
    setDiarizing(false);
    setSpeakerTurns(null);
    splitRef.current?.cancel();
    queueRef.current?.abort();
    liveRecognizerRef.current?.terminate();
    translationAbortRef.current?.abort();
    splitRef.current = null;
    queueRef.current = null;
    liveRecognizerRef.current = null;
    translationRef.current = null;
    translationAbortRef.current = null;
    setStreamingLive(false);
    setTranslation(null);
    setPendingRow(null);
    setSpeakerHint(false);
  }, []);

  // 새로고침, 탭 닫기: 과금 세션을 남기지 않는다. 녹음 조각과 자동 저장본은 기존 복구대로 남는다
  useEffect(() => {
    const onPageHide = () => translationRef.current?.terminate();
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
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
    const engine = selectEngine(modelRef.current.bundle);
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
  /** 파일 인식 시작. append 가 있으면 열린 노트 끝에 다음 파트로 이어 붙이고, 없으면 새 노트 */
  const beginNew = useCallback(
    (selected: File, buffer: ArrayBuffer, sha256: string, append?: AppendTarget) => {
      void (async () => {
        const engine = await ensureEngine();
        if (!engine) return;
        stop();
        setMode('new');
        pendingAudioRef.current = null;
        pendingRetryRef.current = null;
        let id: string;
        if (append) {
          // 열린 노트·제목·재생 중인 앞 파트는 그대로 두고, 본문은 앞 내용 + 구분 제목에서 시작한다
          appendRef.current = append;
          setAppendKind('file');
          pendingIdRef.current = null;
          id = append.key;
          setEditorValue(append.baseDoc);
          setDoc(append.baseDoc);
        } else {
          setActive(null);
          pendingIdRef.current = newProjectId();
          id = pendingIdRef.current;
          setTracksState(nextTracks(singleTrack(selected)));
          setTitle(stripExtension(selected.name));
          setSavedAt(null);
          setEditorValue(null);
          setDoc(null);
        }
        setOutcomes(new Map());
        setExpectedCount(null);
        setDurationMs(null);
        setPhase('splitting');
        // 화자 구분은 16 kHz 로 나뉜 조각을 다시 이어 쓴다 — 서버에 화자 런타임이 없으면 모으지 않는다
        const speakerWavs: Uint8Array[] | null = speakerRuntimeOf(modelRef.current.manifest) ? [] : null;
        toast.show({ id: TRANSCRIBE_TOAST, kind: 'progress', title: '오디오를 나누는 중…', progress: 0 });

        const queue = makeQueue(engine, (outcome) =>
          setOutcomes((previous) => new Map(previous).set(outcome.meta.index, outcome)),
        );
        queueRef.current = queue;

        splitOptionsRef.current = engine.kind === 'ondevice' ? ON_DEVICE_SPLIT_OPTIONS : speakerWavs ? DIARIZED_SPLIT_OPTIONS : DEFAULT_SPLIT_OPTIONS;
        const handle = splitAudioBuffer(
          buffer,
          (chunk) => {
            setPhase((current) => (current === 'splitting' ? 'transcribing' : current));
            speakerWavs?.push(chunk.wav);
            queue.enqueue(chunk);
          },
          splitOptionsRef.current,
        );
        splitRef.current = handle;

        handle.done
          .then((summary) => {
            if (speakerWavs) speakerAudioRef.current = () => wavsToPcm16(speakerWavs);
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

  /**
   * 한 파트의 실패 조각을 그 파트 원본으로 다시 인식한다. 범위는 파트 안 시각으로 바꿔 자르고,
   * 나온 조각은 노트 시간축으로 되돌려 본문의 실패 문단을 찾는다
   */
  const retryPart = useCallback(
    (project: Project, partIndex: number, failed: StoredChunk[], buffer: ArrayBuffer) => {
      const parts = notePartsOf(project);
      const part = parts[partIndex];
      if (!part) return;
      const offset = part.offsetMs;
      const inPart = (chunk: StoredChunk) => partIndexAt(parts, chunk.startMs) === partIndex;
      const local = (chunk: StoredChunk): StoredChunk => ({ ...chunk, startMs: chunk.startMs - offset, endMs: chunk.endMs - offset });
      const isRecording = audioKindOf(part) === 'recording';
      const bytes = new Uint8Array(buffer);
      const extract: RangeExtractor = (ranges, onChunk) => {
        const toNote = (chunk: AudioChunk) => onChunk({ ...chunk, startMs: chunk.startMs + offset, endMs: chunk.endMs + offset });
        return isRecording ? extractWavRanges(bytes, ranges, toNote) : extractAudioRanges(buffer, ranges, toNote);
      };
      // 범위 계산(마지막 조각은 스트림 끝까지)은 이 파트의 조각만으로 한다
      beginRetry(extract, failed.filter(inPart).map(local), { ...project, audio: part, chunks: project.chunks.filter(inPart).map(local) });
    },
    [beginRetry],
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
          setTracksState(nextTracks(singleTrack(selected)));
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
          // 같은 파일은 첫 파트의 원본이다 — 그 파트의 실패 조각만 다시 인식한다
          const parts = notePartsOf(active);
          const failedInFirst = failed.filter((chunk) => partIndexAt(parts, chunk.startMs) === 0);
          if (failedInFirst.length > 0) {
            retryPart(active, 0, failedInFirst, buffer);
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

        if (active && !active.translation) {
          // 열린 노트에 이어 붙일지, 새 노트로 할지 묻는다
          const latest: Project = { ...active, title, doc: docRef.current ?? active.doc };
          const partNumber = notePartsOf(latest).length + 1;
          const choice = await dialog.choose({
            title: '열린 노트에 이어서 붙일까요?',
            description: `이 파일의 인식 결과를 ‘${latest.title.trim() || '제목 없음'}’ 끝에 Part ${partNumber} 로 이어 붙입니다. 새 노트로 시작하면 열린 노트는 그대로 남습니다.`,
            confirmLabel: '이어서 붙이기',
            alternateLabel: '새 노트로 시작',
          });
          if (choice === 'cancel') return;
          if (choice === 'confirm') {
            beginNew(selected, buffer, sha256, prepareAppend(latest, stripExtension(selected.name)));
            return;
          }
        } else if (active) {
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
    [beginNew, retryPart, failWith, toast, dialog, title],
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
      // 이어 붙인 노트는 조각이 든 파트의 원본으로 다시 인식한다
      const parts = notePartsOf(project);
      const partIndex = Math.max(0, partIndexAt(parts, chunk.startMs));
      const part = parts[partIndex];
      const isRecording = audioKindOf(part ?? null) === 'recording';
      const retryWith = (buffer: ArrayBuffer) => retryPart(project, partIndex, [chunk], buffer);
      const attached = tracksState.list.find((track) => track.offsetMs === (part?.offsetMs ?? 0))?.blob;
      void getRecording(partStorageKey(project.id, partIndex))
        .then(async (stored) => {
          if (stored) {
            retryWith(await stored.blob.arrayBuffer());
            return;
          }
          if (attached) {
            retryWith(await attached.arrayBuffer());
            return;
          }
          if (isRecording || partIndex > 0) {
            toast.show({
              kind: 'error',
              title: isRecording ? '녹음 파일을 찾을 수 없습니다' : '이 파트의 원본을 찾을 수 없습니다',
              description: '이 브라우저에 저장된 원본이 지워진 것 같습니다.',
            });
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
    [tracksState.list, retryPart, failWith, toast],
  );

  const resetWorkspace = useCallback(() => {
    stop();
    setActive(null);
    setTracksState(nextTracks(singleTrack(null)));
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
      setTab(tabOfMeta(toMeta(project)));
      setNotice(null);
      const doc = upgradeFailedPlaceholders(project.doc, failedChunksOf(project));
      setMode('new');
      setActive({ ...project, doc });
      setTitle(project.title);
      setEditorValue(doc);
      setDoc(doc);
      setOutcomes(new Map());
      setExpectedCount(project.chunks.length > 0 ? project.chunks.length : null);
      setDurationMs(project.audio ? noteDurationOf(project) : null);
      setSavedAt(project.updatedAt);
      setCurrentMs(0);
      setPhase('review');
      attachAudio({ ...project, doc });
    },
    [stop, setActive, setDoc, attachAudio],
  );

  /** 디바운스 대기 중인 자동 저장을 바로 반영한다 */
  const flushAutosave = useCallback(() => {
    const active = activeRef.current;
    const doc = docRef.current;
    if (phase !== 'review' || !active || !doc) return;
    if (active.doc === doc && active.title === title) return;
    const updated: Project = { ...active, title, doc, updatedAt: Date.now() };
    setActive(updated);
    persist(updated);
  }, [phase, title, setActive, persist]);

  /** 그 탭의 마지막 노트 → 최신 노트 → 빈 화면 순으로 연다 */
  const moveToTab = useCallback(
    (next: WorkspaceTab) => {
      setNotice(null);
      const metas = listProjects(window.localStorage).filter((meta) => tabOfMeta(meta) === next);
      const lastId = readWorkspaceState().lastNote[next];
      const target = metas.find((meta) => meta.id === lastId) ?? metas[0];
      setTab(next);
      if (target) openProject(target.id);
      else resetWorkspace();
    },
    [openProject, resetWorkspace],
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
        // 이어 붙인 파트의 원본까지 지운다
        const partCount = Math.max(1, target ? notePartsOf(target).length : 1);
        for (let index = 0; index < partCount; index += 1) {
          const key = partStorageKey(id, index);
          void deleteRecording(key).catch(() => {});
          void deleteRecordingParts(key).catch(() => {});
        }
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
    setTracksState(nextTracks(singleTrack(null)));
    setTitle(project.title);
    setOutcomes(new Map());
    setExpectedCount(null);
    setDurationMs(null);
    setEditorValue(EMPTY_DOC);
    setDoc(EMPTY_DOC);
    setCurrentMs(0);
    setPhase('review');
  }, [phase, stop, setActive, persist, setDoc]);

  const connecting = translation !== null && phase !== 'recording' && translation.status === 'connecting';
  const draining = translation?.status === 'draining';
  const locked = phase === 'splitting' || phase === 'transcribing' || connecting || draining;

  const switchTab = useCallback(
    (next: WorkspaceTab) => {
      if (next === tab || locked) return;
      if (phase === 'recording') {
        void dialog
          .confirm({
            title: translationRef.current ? '번역을 저장하고 이동할까요?' : '녹음을 저장하고 이동할까요?',
            confirmLabel: '저장하고 이동',
            cancelLabel: translationRef.current ? '계속 번역' : '계속 녹음',
            defaultAction: 'cancel',
          })
          .then((proceed) => {
            if (!proceed) return;
            pendingTabRef.current = next;
            stopRecordingRef.current();
          });
        return;
      }
      flushAutosave();
      moveToTab(next);
    },
    [tab, locked, phase, dialog, flushAutosave, moveToTab],
  );

  const translationNotice = useCallback((): NoticeKind | null => {
    if (!supportsTranslation()) return 'unsupported';
    return resolveTranslationKey(readByokSettings(), readTranslationSettings()) ? null : 'key';
  }, []);

  // 번역 탭 빈 화면: 시작할 수 없으면 언어를 고르게 하지 않고 안내를 보여 준다
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setEmptyNotice(tab === 'translate' && hydrated ? translationNotice() : null);
  }, [tab, hydrated, translationNotice]);

  const openNewTranslation = useCallback(() => {
    if (phase === 'splitting' || phase === 'transcribing' || phase === 'recording') return;
    const blocked = translationNotice();
    if (blocked) {
      setNotice(blocked);
      return;
    }
    const { sourceLanguage, targetLanguage, speakerOn } = readTranslationSettings();
    setNewTranslation({ choice: { sourceLanguage, targetLanguage, speakerOn }, focus: 'source' });
    void navigator.mediaDevices
      .enumerateDevices()
      .then((devices) => {
        // 마이크 권한을 준 적이 없으면 라벨이 비어 있다
        const label = devices.find((device) => device.kind === 'audioinput' && device.label)?.label;
        if (label) setMicLabel(label);
      })
      .catch(() => {});
  }, [phase, translationNotice]);

  const closeNewTranslation = useCallback(() => {
    setNewTranslation(null);
    setTimeout(() => sidebarRef.current?.focusNewTranslation(), 0);
  }, []);

  /** 번역 시작 실패 — 노트를 만들지 않고 고른 값으로 레이어에 돌아간다 */
  const failTranslationStart = useCallback(
    async (error: unknown, choice: TranslationChoice) => {
      const kind = classifyStartError(error);
      const message = error instanceof Error ? error.message : String(error);
      const reopen = () => setNewTranslation({ choice, focus: 'start' });
      if (kind === 'aborted') return;
      if (kind === 'session') {
        toast.show({
          kind: 'error',
          title: '로그인이 만료되었습니다',
          description: '편집 내용은 이 브라우저에 저장돼 있습니다.',
          duration: 0,
          actions: [{ label: '다시 로그인', primary: true, onClick: () => window.location.reload() }],
        });
        return;
      }
      if (kind === 'mic') {
        reopen();
        toast.show({ kind: 'error', title: '마이크를 시작할 수 없습니다', description: message });
        return;
      }
      if (kind === 'key' || kind === 'access' || kind === 'request' || kind === 'quota') {
        const openSettings = await dialog.confirm({
          title: kind === 'key' ? 'API 키를 확인하세요' : kind === 'request' ? '번역 설정을 확인하세요' : '번역을 시작할 수 없습니다',
          description: message,
          confirmLabel: '설정 열기',
          cancelLabel: '닫기',
        });
        if (openSettings) router.push('/settings#translation');
        else reopen();
        return;
      }
      reopen();
      toast.show({ kind: 'error', title: '번역을 연결하지 못했습니다', description: message });
    },
    [toast, dialog, router],
  );

  /** 번역 시작: 전사 엔진을 타지 않는다. 연결된 뒤에만 노트를 만든다 */
  const startTranslation = useCallback(
    (choice: TranslationChoice) => {
      const settings = writeTranslationSettings({ ...readTranslationSettings(), ...choice });
      const apiKey = resolveTranslationKey(readByokSettings(), settings);
      stop();
      // 라이브 화면 동안 에디터가 내려간다. 취소하거나 실패해 돌아올 때 지금 글로 다시 올라오게 한다
      setEditorValue(docRef.current);
      setNewTranslation(null);
      setNotice(null);
      // 포커스를 본문으로 옮겨 Space, M, Esc 가 동작하게 한다
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      const { sourceLanguage, targetLanguage, speakerOn } = choice;
      const startedAt = Date.now();
      const noteTitle = `번역 ${formatDateTime(startedAt)}`;
      setTab('translate');
      setPendingRow({ title: noteTitle, meta: `${pairLabel(sourceLanguage, targetLanguage)} · 연결 중` });
      setSpeakerHint(speakerOn && !settings.speakerHintSeen);
      setTranslation({
        status: 'connecting',
        delayed: false,
        speaker: { intent: speakerOn ? 'on' : 'off', blocked: false, fuseTripped: false },
        partial: { source: '', translation: '' },
        sourceLanguage,
        targetLanguage,
        pausedAtMs: null,
        bannerDismissed: false,
        micLost: false,
      });
      setOutcomes(new Map());
      liveIndexRef.current = 0;
      liveSentMsRef.current = 0;
      const patchSession = (patch: Partial<TranslationSession>) =>
        setTranslation((previous) => (previous ? { ...previous, ...patch } : previous));
      const handlers: TranslationHandlers = {
        onPartial: (text, _processedMs, translated = '') =>
          setTranslation((previous) =>
            previous && (previous.partial.source !== text || previous.partial.translation !== translated)
              ? { ...previous, partial: { source: text, translation: translated } }
              : previous,
          ),
        onFinal: (segment) => {
          const index = liveIndexRef.current;
          liveIndexRef.current += 1;
          const meta: ChunkMeta = { index, startMs: segment.startMs, endMs: segment.endMs };
          setOutcomes((previous) =>
            new Map(previous).set(index, { kind: 'ok', meta, text: segment.text, translation: segment.translation }),
          );
        },
        onError: (error) => console.warn(error.message),
        onStatus: (status) => patchSession({ status }),
        onDelay: (delayed) => patchSession({ delayed }),
        onSpeaker: (speaker) => patchSession({ speaker }),
        onMicLost: () => patchSession({ micLost: true }),
        onFuseTripped: () => toast.show({ kind: 'info', title: '에코가 감지되었습니다', description: '이어폰을 쓰세요' }),
      };
      const controller = new AbortController();
      translationAbortRef.current = controller;
      void (async () => {
        let recognizer: TranslationRecognizer;
        try {
          recognizer = await startTranslationRecognizer(
            { apiKey, targetLanguage, noiseReduction: settings.noiseReduction, speakerOn, signal: controller.signal },
            handlers,
          );
        } catch (error) {
          // 취소는 stop 이 이미 화면을 되돌렸다. 그사이 시작한 새 세션을 건드리지 않는다
          if (controller.signal.aborted) return;
          translationAbortRef.current = null;
          setTranslation(null);
          setPendingRow(null);
          setSpeakerHint(false);
          await failTranslationStart(error, choice);
          return;
        }
        if (controller.signal.aborted) {
          recognizer.terminate();
          return;
        }
        translationAbortRef.current = null;
        translationRef.current = recognizer;
        liveRecognizerRef.current = recognizer;
        setPendingRow(null);
        const now = Date.now();
        const id = newProjectId();
        const audio: ProjectAudio = {
          kind: 'recording',
          name: `${noteTitle}.wav`,
          size: 0,
          sha256: '',
          durationMs: 0,
          mimeType: 'audio/wav',
        };
        const project: Project = {
          id,
          title: noteTitle,
          createdAt: now,
          updatedAt: now,
          audio,
          splitOptions: null,
          chunks: [],
          doc: EMPTY_DOC,
          translation: { sourceLanguage, targetLanguage, model: 'gpt-realtime-translate' },
        };
        setMode('new');
        setActive(project);
        persist(project);
        pendingAudioRef.current = audio;
        pendingRetryRef.current = null;
        setTracksState(nextTracks(singleTrack(null)));
        setTitle(noteTitle);
        setExpectedCount(null);
        setDurationMs(null);
        setEditorValue(EMPTY_DOC);
        setDoc(EMPTY_DOC);
        setCurrentMs(0);
        queueRef.current = null;
        setPhase('recording');
        live.start(id, recognizer.micTrack).catch((error: unknown) => {
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
    },
    [stop, setActive, persist, setDoc, live, resetWorkspace, refreshProjects, toast, failTranslationStart],
  );

  const openDrawer = useCallback(() => {
    menuReturnRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDrawerOpen(true);
  }, []);

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    menuReturnRef.current?.focus();
  }, []);

  // 노트를 열거나 번역 레이어를 띄우면 서랍을 닫는다
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDrawerOpen(false);
  }, [activeProject?.id, newTranslation, phase, tab]);

  const pauseRecording = useCallback(() => {
    live.pause();
    translationRef.current?.pause();
    setTranslation((previous) => (previous ? { ...previous, pausedAtMs: Date.now() } : previous));
  }, [live]);

  const resumeRecording = useCallback(() => {
    live.resume();
    void translationRef.current?.resume();
    setTranslation((previous) => (previous ? { ...previous, pausedAtMs: null } : previous));
  }, [live]);

  const speakerIntent = translation?.speaker;
  const toggleSpeaker = useCallback(() => {
    if (!speakerIntent) return;
    const intent = speakerView(speakerIntent) === 'on' ? 'off' : 'on';
    void translationRef.current?.setSpeaker(intent);
    writeTranslationSettings({
      ...readTranslationSettings(),
      speakerOn: intent === 'on',
      speakerHintSeen: readTranslationSettings().speakerHintSeen || intent === 'off',
    });
    if (intent === 'off') setSpeakerHint(false);
  }, [speakerIntent]);

  /** 녹음 시작: 엔진을 확보하고(On-Device 면 whisper 워커에 모델까지 올린 뒤) 빈 녹음 노트를 만들고 마이크를 연다 (권한 거부 시 노트는 지운다) */
  const startRecording = useCallback(() => {
    if (phase === 'splitting' || phase === 'transcribing' || phase === 'recording') return;
    void (async () => {
      // 노트가 열려 있으면 그 노트에 이어서 녹음할지, 새 노트로 녹음할지 묻는다
      const opened = activeRef.current;
      let append: AppendTarget | null = null;
      if (opened && !opened.translation) {
        const latest: Project = { ...opened, title, doc: docRef.current ?? opened.doc };
        const partNumber = notePartsOf(latest).length + 1;
        const choice = await dialog.choose({
          title: '열린 노트에 이어서 녹음할까요?',
          description: `‘${latest.title.trim() || '제목 없음'}’ 끝에 Part ${partNumber} 로 이어서 받아씁니다. 새 노트로 녹음하면 열린 노트는 그대로 남습니다.`,
          confirmLabel: '이어서 녹음',
          alternateLabel: '새 노트로 녹음',
        });
        if (choice === 'cancel') return;
        if (choice === 'confirm') append = prepareAppend(latest, `녹음 ${formatDateTime(Date.now())}`);
      }
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
      // 스트리밍 엔진: On-Device 는 whisper 반복 인식(파일 전사와 같은 모델·워커), BYOK 는 Realtime 전용 모델.
      // 그 밖의 BYOK 는 조각 단위 큐로 보낸다. On-Device 가 실패해도 음성을 API 로 보내지 않는다
      const settings = readByokSettings();
      const bundle = modelRef.current.bundle;
      if (engine.kind === 'ondevice' && !bundle) return;
      const startStreaming =
        engine.kind === 'ondevice' && bundle
          ? () => startWhisperLive(bundle, handlers)
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
            duration: 10_000,
            actions: message.includes('다시 내려받아야')
              ? [{ label: '다시 받기', primary: true, onClick: () => modelRef.current.start() }]
              : message.includes('메모리')
                ? [{ label: '설정 열기', primary: true, onClick: () => router.push('/settings') }]
                : undefined,
          });
          return;
        }
        // GPU 가속 없이 큰 모델을 돌리면 자막이 입력보다 늦을 수 있다 — 녹음·저장은 그대로다
        if (engine.kind === 'ondevice' && bundle?.model.tier === 'full' && whisperBackend() === 'cpu') {
          toast.show({
            kind: 'info',
            title: 'GPU 가속 없이 인식합니다',
            description: '이 브라우저에서 WebGPU 를 쓸 수 없어 실시간 자막이 늦게 확정될 수 있습니다. 녹음은 그대로 저장됩니다.',
            duration: 8000,
          });
        }
      }
      const now = Date.now();
      const noteTitle = `녹음 ${formatDateTime(now)}`;
      const audio: ProjectAudio = {
        kind: 'recording',
        name: `${noteTitle}.wav`,
        size: 0,
        sha256: '',
        durationMs: 0,
        mimeType: 'audio/wav',
      };
      setMode('new');
      pendingAudioRef.current = audio;
      pendingRetryRef.current = null;
      setOutcomes(new Map());
      setExpectedCount(null);
      setDurationMs(null);
      // 원본 녹음은 파트 키로 저장한다 — 새 노트면 노트 id, 이어 붙이면 id#N
      let storageKey: string;
      if (append) {
        appendRef.current = append;
        setAppendKind('recording');
        storageKey = append.key;
        setEditorValue(append.baseDoc);
        setDoc(append.baseDoc);
      } else {
        const id = newProjectId();
        storageKey = id;
        const project: Project = { id, title: noteTitle, createdAt: now, updatedAt: now, audio, splitOptions: null, chunks: [], doc: EMPTY_DOC };
        setActive(project);
        persist(project);
        setTracksState(nextTracks(singleTrack(null)));
        setTitle(noteTitle);
        setEditorValue(EMPTY_DOC);
        setDoc(EMPTY_DOC);
        setCurrentMs(0);
      }
      queueRef.current = liveRecognizerRef.current
        ? null
        : makeQueue(engine, (outcome) => setOutcomes((previous) => new Map(previous).set(outcome.meta.index, outcome)));
      setPhase('recording');
      live.start(storageKey).catch((error: unknown) => {
        stop();
        if (append) {
          // 이어 붙이기를 시작하지 못했다 — 열린 노트를 원래대로 둔다
          setEditorValue(append.base.doc);
          setDoc(append.base.doc);
          setPhase('review');
        } else {
          deleteProject(window.localStorage, storageKey);
          resetWorkspace();
          refreshProjects();
        }
        toast.show({
          kind: 'error',
          title: '마이크를 시작할 수 없습니다',
          description: error instanceof Error ? error.message : String(error),
        });
      });
    })();
  }, [phase, stop, setActive, persist, setDoc, makeQueue, live, resetWorkspace, refreshProjects, toast, ensureEngine, router, dialog, title]);

  /** 녹음 중지: 마지막 조각까지 보내고, WAV 를 저장한 뒤 남은 인식이 끝나면 완료 효과가 노트를 확정한다 */
  const stopRecording = useCallback(() => {
    if (stoppingRef.current || phase !== 'recording') return;
    stoppingRef.current = true;
    const translating = translationRef.current !== null;
    if (translating) setTranslation((previous) => (previous ? { ...previous, status: 'draining' } : previous));
    else toast.show({ id: TRANSCRIBE_TOAST, kind: 'progress', title: '녹음을 마무리하는 중…', progress: 0 });
    live
      .stop()
      .then(async (result) => {
        const audio = pendingAudioRef.current;
        pendingAudioRef.current = audio ? { ...audio, durationMs: result.durationMs, size: result.blob.size } : audio;
        if (!appendRef.current) setTracksState(nextTracks(singleTrack(result.blob)));
        setDurationMs(result.durationMs);
        durationRef.current = result.durationMs;
        if (!translating && speakerRuntimeOf(modelRef.current.manifest)) {
          const bytes = new Uint8Array(await result.blob.arrayBuffer());
          speakerAudioRef.current = () => wavsToPcm16([bytes]);
        }
        const recognizer = liveRecognizerRef.current;
        if (recognizer) {
          // 마지막 세그먼트(finish 중 final)가 들어온 뒤에 기대 개수를 정한다
          await recognizer.finish();
          liveRecognizerRef.current = null;
          translationRef.current = null;
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

  useEffect(() => {
    stopRecordingRef.current = stopRecording;
  }, [stopRecording]);

  // 번역이 끝나 노트가 확정되면 저장본 화면으로 바꾼다
  useEffect(() => {
    if (phase !== 'review' || !translation || translationRef.current || translationAbortRef.current) return;
    setTranslation(null);
    setSpeakerHint(false);
    const settings = readTranslationSettings();
    if (speakerHint && !settings.speakerHintSeen) writeTranslationSettings({ ...settings, speakerHintSeen: true });
  }, [phase, translation, speakerHint]);

  // 저장하고 이동: 노트가 확정되면 기다리던 탭으로 옮긴다
  useEffect(() => {
    if (phase === 'error') pendingTabRef.current = null;
    if (phase !== 'review' || !pendingTabRef.current) return;
    const next = pendingTabRef.current;
    pendingTabRef.current = null;
    moveToTab(next);
  }, [phase, moveToTab]);

  // 녹음 중 자동 저장: 조각 결과가 올 때마다(1초 디바운스) 본문·조각·길이를 노트에 반영한다
  useEffect(() => {
    if (phase !== 'recording') return;
    const timer = setTimeout(() => {
      const active = activeRef.current;
      if (!active) return;
      const append = appendRef.current;
      const pending = pendingAudioRef.current;
      const updated: Project =
        append && pending
          ? appendedProject(
              append,
              { ...pending, durationMs: live.emittedMs },
              outcomesToChunks(outcomes),
              docRef.current ?? append.baseDoc,
              title,
              Date.now(),
            )
          : {
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
      const parts = project ? notePartsOf(project) : [];
      const count = Math.max(1, parts.length);
      void (async () => {
        // 이어 붙인 노트는 파트마다 파일 하나씩 내려받는다
        let saved = 0;
        let bytes = 0;
        for (let index = 0; index < count; index += 1) {
          const stored = await getRecording(partStorageKey(id, index));
          if (!stored) continue;
          const part = parts[index];
          const isRecording = audioKindOf(part ?? project?.audio) === 'recording';
          const base = project?.title.trim() || (isRecording ? 'recording' : 'audio');
          const suffix = count > 1 ? ` (Part ${index + 1})` : '';
          const filename = isRecording
            ? `${base}${suffix}.wav`
            : count > 1
              ? `${base}${suffix} - ${part?.name ?? 'audio.mp3'}`
              : part?.name || `${base}.mp3`;
          downloadBlob(stored.blob, filename);
          saved += 1;
          bytes += stored.blob.size;
        }
        if (saved === 0) {
          toast.show({
            kind: 'error',
            title: '오디오 파일을 찾을 수 없습니다',
            description: '이 브라우저에 원본이 없습니다. 오디오를 다시 불러오면 저장됩니다.',
          });
          return;
        }
        toast.show({
          kind: 'success',
          title: saved > 1 ? `오디오 파일 ${saved}개 저장` : '오디오 파일 저장',
          description: `${(bytes / (1024 * 1024)).toFixed(1)}MB${saved < count ? ` · ${count - saved}개 파트는 원본이 없습니다` : ''}`,
        });
      })().catch(failWith);
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

  /** 연결 중이면 취소, 그 뒤로는 저장하며 끝낸다 */
  const stopTranslation = () => {
    if (phase === 'recording') stopRecording();
    else stop();
  };

  const tabProjects = useMemo(() => projects.filter((meta) => tabOfMeta(meta) === tab), [projects, tab]);
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
  const noteTranslation = activeProject?.translation;
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
    <>
    <div className={styles.shell} inert={newTranslation !== null}>
      <TopBar title={title} titleVisible={activeProject !== null || busy} onTitleChange={setTitle} navLocked={recording || translation !== null}
        onOpenMenu={openDrawer}
        subtitle={translation ? pairLabel(translation.sourceLanguage, translation.targetLanguage) : null}
        inert={drawerOpen}
      />

      <div className={styles.frame}>
        <SidebarDrawer open={drawerOpen} onClose={closeDrawer}>
          <Sidebar
            ref={sidebarRef}
            tab={tab}
            projects={tabProjects}
            activeId={connecting ? null : (activeProject?.id ?? null)}
            disabled={busy || translation !== null}
            recording={recording}
            onSelectAudio={start}
            onImport={importProject}
            onToggleRecord={translation !== null ? stopTranslation : recording ? stopRecording : startRecording}
            onNewNote={createBlankNote}
            onOpen={openProject}
            onRename={renameProject}
            onExportJson={exportProject}
            onExportDoc={exportProjectDoc}
            onDownloadAudio={downloadAudio}
            onDelete={removeProject}
            onNewTranslation={openNewTranslation}
            newTranslationOpen={newTranslation !== null}
            translating={translation !== null}
            liveLabel={translation?.status === 'paused' || translation?.status === 'parked' ? '일시정지' : '번역 중'}
            pendingRow={pendingRow}
            speakerHint={speakerHint}
          />
        </SidebarDrawer>

        <TabRow
          tab={tab}
          running={
            translation !== null
              ? { tab: 'translate', muted: live.status === 'paused' || draining }
              : recording
                ? { tab, muted: live.status === 'paused' }
                : null
          }
          locked={locked}
          onSelect={switchTab}
          savedAt={phase === 'review' ? savedAt : null}
          exportDisabled={phase !== 'review' || !currentDoc}
          onExport={exportDocument}
        />

        <div className={styles.sheet} inert={drawerOpen}>
          <main className={styles.main}>
            <div className={styles.editorColumn}>
              {translation ? (
                <TranslationLiveView
                  blocks={assembled.blocks}
                  partial={translation.partial}
                  nextStartMs={live.emittedMs}
                  status={translation.status}
                  delayed={translation.delayed}
                  sourceLanguage={translation.sourceLanguage}
                  targetLanguage={translation.targetLanguage}
                  banner={
                    translation.bannerDismissed && translation.status === 'unavailable' ? null : (
                      <TranslationBanner
                        status={translation.status}
                        pausedAtMs={translation.pausedAtMs}
                        speakerBlocked={translation.speaker.blocked}
                        speakerOn={translation.speaker.intent === 'on'}
                        micLost={translation.micLost}
                        onReconnect={() => void translationRef.current?.reconnect()}
                        onDismissUnavailable={() => setTranslation((previous) => (previous ? { ...previous, bannerDismissed: true } : previous))}
                      />
                    )
                  }
                />
              ) : notice || (emptyNotice && !showEditor) ? (
                <TranslationNotice
                  kind={(notice ?? emptyNotice) as NoticeKind}
                  onOpenSettings={() => router.push('/settings#translation')}
                  onGoTranscribe={() => moveToTab('transcribe')}
                />
              ) : showEditor ? (
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
                  showSource={showSource}
                  onToggleSource={noteTranslation ? () => setShowSource((v) => !v) : null}
                  noteLabel={noteTranslation ? `${pairLabel(noteTranslation.sourceLanguage, noteTranslation.targetLanguage)} 번역 노트` : undefined}
                />
              ) : (
                <div className={styles.empty}>
                  {tab === 'translate' ? (
                    <>
                      <span className={styles.emptyTitle}>새 번역을 시작하세요</span>
                      <span>왼쪽의 새 번역을 누르면 언어를 고르고 시작합니다. 저장된 번역 노트는 목록에서 열 수 있습니다.</span>
                      <button type="button" className={styles.emptyAction} onClick={openNewTranslation}>
                        새 번역
                      </button>
                    </>
                  ) : (
                    <>
                      <span className={styles.emptyTitle}>오디오를 불러오거나 녹음을 시작하세요</span>
                      <span>오디오를 선택하거나 마이크로 녹음하면 인식이 시작되고, 결과는 이 브라우저에 노트로 저장됩니다.</span>
                    </>
                  )}
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

          {recording || translation ? (
            <RecordingBar
              elapsedMs={recording ? live.elapsedMs : 0}
              paused={live.status === 'paused'}
              levelsRef={live.levelsRef}
              onPause={recording ? pauseRecording : noop}
              onResume={recording ? resumeRecording : noop}
              onStop={translation ? stopTranslation : stopRecording}
              speaker={translation ? { view: speakerView(translation.speaker), onToggle: toggleSpeaker } : undefined}
            />
          ) : tab === 'translate' && !showEditor ? null : (
            <PlayerBar
              key={tracksState.version}
              ref={playerRef}
              tracks={tracksState.list}
              durationMs={durationMs}
              onTimeUpdate={setCurrentMs}
            />
          )}
          {tab === 'transcribe' && !recording ? (
            <div className={styles.mobileBar}>
              <button type="button" className={styles.mobileRecord} disabled={busy} onClick={startRecording}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="9" y="3" width="6" height="11" rx="3" />
                  <path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8" />
                </svg>
                녹음
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>

    {newTranslation ? (
      <NewTranslationDialog
        initial={newTranslation.choice}
        initialFocus={newTranslation.focus}
        micLabel={micLabel}
        onClose={closeNewTranslation}
        onStart={startTranslation}
      />
    ) : null}
    </>
  );
};