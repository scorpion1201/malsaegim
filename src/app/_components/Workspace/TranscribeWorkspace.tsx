'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { assembleTranscript, type ChunkOutcome } from '@/app/_lib/asr/assembleTranscript';
import { CLIENT_CONCURRENCY, createTranscribeQueue, type TranscribeQueue } from '@/app/_lib/asr/transcribeQueue';
import { sha256Hex } from '@/app/_lib/audio/fileHash';
import { extractAudioRanges, splitAudioBuffer, type SplitHandle } from '@/app/_lib/audio/splitAudioFile';
import { DEFAULT_SPLIT_OPTIONS, type ExtractRange } from '@/app/_lib/audio/types';
import { blocksToTiptapDoc } from '@/app/_lib/editor/blocksToTiptapDoc';
import { patchFailedParagraph, upgradeFailedPlaceholders } from '@/app/_lib/editor/patchTranscript';
import {
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
import type { TiptapDoc } from '@/app/_lib/hwp/tiptapToDocModel';
import { Editor } from '../Editor/Editor';
import { PlayerBar, type PlayerBarHandle } from '../PlayerBar/PlayerBar';
import { useToast } from '../Toast/ToastProvider';
import { Sidebar, type SidebarHandle } from './Sidebar';
import { TopBar } from './TopBar';
import styles from './Workspace.module.css';

type Phase = 'idle' | 'splitting' | 'transcribing' | 'review' | 'error';
type RunMode = 'new' | 'retry';

const TRANSCRIBE_TOAST = 'transcribe';
const RETRY_TOAST = 'retry';

const stripExtension = (name: string) => name.replace(/\.[^.]+$/, '');

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

export const TranscribeWorkspace = () => {
  const toast = useToast();

  const [phase, setPhase] = useState<Phase>('idle');
  const [mode, setMode] = useState<RunMode>('new');
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [outcomes, setOutcomes] = useState<Map<number, ChunkOutcome>>(new Map());
  const [expectedCount, setExpectedCount] = useState<number | null>(null);
  const [durationMs, setDurationMs] = useState<number | null>(null);
  const [editorValue, setEditorValue] = useState<TiptapDoc | null>(null);
  const [currentDoc, setCurrentDoc] = useState<TiptapDoc | null>(null);
  const [currentMs, setCurrentMs] = useState(0);
  const [showTimestamps, setShowTimestamps] = useState(true);
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [retryDone, setRetryDone] = useState(0);
  const [retryTotal, setRetryTotal] = useState(0);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const playerRef = useRef<PlayerBarHandle>(null);
  const sidebarRef = useRef<SidebarHandle>(null);
  const splitRef = useRef<SplitHandle | null>(null);
  const queueRef = useRef<TranscribeQueue | null>(null);
  const docRef = useRef<TiptapDoc | null>(null);
  const activeRef = useRef<Project | null>(null);
  const pendingAudioRef = useRef<ProjectAudio | null>(null);
  const pendingRetryRef = useRef<number | null>(null);

  const assembled = useMemo(() => assembleTranscript(outcomes, expectedCount), [outcomes, expectedCount]);

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

  // 조립 결과 → 에디터 + 진행 토스트 (새 인식 중에만)
  useEffect(() => {
    if (mode !== 'new' || (phase !== 'transcribing' && phase !== 'splitting')) return;
    const doc = blocksToTiptapDoc(assembled.blocks);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setEditorValue(doc);
    setDoc(doc);
    if (phase === 'transcribing') {
      const total = expectedCount ?? assembled.readyCount + assembled.heldCount;
      toast.update(TRANSCRIBE_TOAST, {
        title: `인식 중 · 조각 ${assembled.readyCount}/${expectedCount ?? `${total}+`}`,
        description: assembled.heldCount > 0 ? `순서 대기 ${assembled.heldCount}` : undefined,
        progress: expectedCount ? (assembled.readyCount / expectedCount) * 100 : 0,
        meta: expectedCount ? `${Math.round((assembled.readyCount / expectedCount) * 100)}%` : undefined,
      });
    }
  }, [assembled, phase, mode, expectedCount, setDoc, toast]);

  // 새 인식이 전부 끝나면 프로젝트로 저장하고 검수 단계로
  useEffect(() => {
    if (mode !== 'new' || phase !== 'transcribing' || !assembled.complete) return;
    const doc = docRef.current ?? blocksToTiptapDoc(assembled.blocks);
    const chunks: StoredChunk[] = Array.from(outcomes.values())
      .sort((a, b) => a.meta.index - b.meta.index)
      .map((outcome) => ({
        index: outcome.meta.index,
        startMs: outcome.meta.startMs,
        endMs: outcome.meta.endMs,
        status: outcome.kind === 'ok' ? 'ok' : 'failed',
      }));
    const now = Date.now();
    const project: Project = {
      id: activeRef.current?.id ?? newProjectId(),
      title,
      createdAt: activeRef.current?.createdAt ?? now,
      updatedAt: now,
      audio: pendingAudioRef.current,
      splitOptions: DEFAULT_SPLIT_OPTIONS,
      chunks,
      doc,
    };
    setActive(project);
    persist(project);
    setPhase('review');
    const failed = chunks.filter((chunk) => chunk.status === 'failed').length;
    toast.update(TRANSCRIBE_TOAST, {
      kind: failed > 0 ? 'error' : 'success',
      title: failed > 0 ? `인식 완료 · 실패 ${failed}개` : '인식 완료',
      description: failed > 0 ? '실패한 조각 옆 새로고침을 누르면 그 구간만 다시 인식합니다.' : `${chunks.length}개 조각`,
      progress: undefined,
      meta: undefined,
      duration: failed > 0 ? 8000 : 4000,
    });
  }, [mode, phase, assembled, outcomes, title, setActive, persist, toast]);

  // 최초 진입: 예전 단일 초안 마이그레이션 + 목록 로드 + 최근 프로젝트 자동 열기
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
    splitRef.current = null;
    queueRef.current = null;
  }, []);

  useEffect(() => stop, [stop]);

  const failWith = useCallback(
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      const expired = message.includes('401');
      setPhase('error');
      stop();
      toast.dismiss(TRANSCRIBE_TOAST);
      toast.dismiss(RETRY_TOAST);
      toast.show({
        kind: 'error',
        title: expired ? '로그인이 만료되었습니다' : '인식을 계속할 수 없습니다',
        description: expired ? '편집 내용은 이 브라우저에 저장돼 있습니다.' : message,
        duration: 0,
        actions: expired ? [{ label: '다시 로그인', primary: true, onClick: () => window.location.reload() }] : undefined,
      });
    },
    [stop, toast],
  );

  const makeQueue = useCallback(
    (onOutcome: (outcome: ChunkOutcome) => void) =>
      createTranscribeQueue(
        { concurrency: CLIENT_CONCURRENCY, maxRetries: 3 },
        { onOutcome, onFatal: failWith },
      ),
    [failWith],
  );

  /** 새 프로젝트: 무음 분할 → 전 조각 인식 */
  const beginNew = useCallback(
    (selected: File, buffer: ArrayBuffer, sha256: string) => {
      stop();
      setMode('new');
      setActive(null);
      pendingAudioRef.current = null;
      pendingRetryRef.current = null;
      setFile(selected);
      setTitle(stripExtension(selected.name));
      setOutcomes(new Map());
      setExpectedCount(null);
      setDurationMs(null);
      setSavedAt(null);
      setEditorValue(null);
      setDoc(null);
      setPhase('splitting');
      toast.show({ id: TRANSCRIBE_TOAST, kind: 'progress', title: '오디오를 나누는 중…', progress: 0 });

      const queue = makeQueue((outcome) =>
        setOutcomes((previous) => new Map(previous).set(outcome.meta.index, outcome)),
      );
      queueRef.current = queue;

      const handle = splitAudioBuffer(buffer, (chunk) => {
        setPhase((current) => (current === 'splitting' ? 'transcribing' : current));
        queue.enqueue(chunk);
      });
      splitRef.current = handle;

      handle.done
        .then((summary) => {
          setExpectedCount(summary.chunkCount);
          setDurationMs(summary.totalMs);
          pendingAudioRef.current = {
            name: selected.name,
            size: selected.size,
            sha256,
            durationMs: summary.totalMs,
          };
          return queue.close();
        })
        .catch(failWith);
    },
    [stop, setActive, setDoc, makeQueue, failWith, toast],
  );

  /** 재인식: 저장된 시간 구간만 추출해 실패 조각만 다시 보낸다 */
  const beginRetry = useCallback(
    (buffer: ArrayBuffer, failed: StoredChunk[], project: Project) => {
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
      const queue = makeQueue((outcome) => {
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

      const handle = extractAudioRanges(buffer, toExtractRanges(failed, project.chunks), (chunk) =>
        queue.enqueue(chunk),
      );
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
    },
    [stop, makeQueue, setActive, persist, failWith, toast],
  );

  /** 파일 선택: 같은 오디오면 재생 연결·부분 재인식, 다른 파일이면 새 프로젝트 */
  const start = useCallback(
    (selected: File) => {
      void (async () => {
        const buffer = await selected.arrayBuffer();
        const sha256 = await sha256Hex(buffer); // transfer 전에 해시부터
        const active = activeRef.current;
        const pending = pendingRetryRef.current;
        pendingRetryRef.current = null;

        if (active?.audio && active.audio.sha256 === sha256) {
          setFile(selected);
          setDurationMs(active.audio.durationMs);
          const allFailed = failedChunksOf(active);
          const failed = pending === null ? allFailed : allFailed.filter((chunk) => chunk.index === pending);
          if (failed.length > 0) {
            beginRetry(buffer, failed, active);
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
            description: '이 프로젝트의 오디오와 내용이 다릅니다. 원본 파일을 선택하세요.',
          });
          return;
        }

        if (active) {
          const proceed = window.confirm('열려 있는 프로젝트와 다른 파일입니다. 새 프로젝트로 시작할까요?');
          if (!proceed) return;
        }
        beginNew(selected, buffer, sha256);
      })().catch(failWith);
    },
    [beginNew, beginRetry, failWith, toast],
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
      if (file) {
        void file
          .arrayBuffer()
          .then((buffer) => beginRetry(buffer, [chunk], project))
          .catch(failWith);
        return;
      }
      pendingRetryRef.current = chunk.index;
      toast.show({
        kind: 'info',
        title: '오디오를 먼저 불러오세요',
        description: '같은 파일을 선택하면 이 조각만 다시 인식합니다.',
      });
      sidebarRef.current?.openAudioPicker();
    },
    [file, beginRetry, failWith, toast],
  );

  const resetWorkspace = useCallback(() => {
    stop();
    setActive(null);
    setFile(null);
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
      setFile(null);
      setTitle(project.title);
      setEditorValue(doc);
      setDoc(doc);
      setOutcomes(new Map());
      setExpectedCount(project.chunks.length > 0 ? project.chunks.length : null);
      setDurationMs(project.audio?.durationMs ?? null);
      setSavedAt(project.updatedAt);
      setCurrentMs(0);
      setPhase('review');
    },
    [stop, setActive, setDoc],
  );

  const removeProject = useCallback(
    (id: string) => {
      if (!window.confirm('프로젝트를 삭제할까요? 되돌릴 수 없습니다.')) return;
      deleteProject(window.localStorage, id);
      refreshProjects();
      if (activeRef.current?.id === id) resetWorkspace();
      toast.show({ kind: 'info', title: '프로젝트를 삭제했습니다' });
    },
    [refreshProjects, resetWorkspace, toast],
  );

  const exportProject = useCallback((id: string) => {
    const project = loadProject(window.localStorage, id);
    if (!project) return;
    downloadBlob(
      new Blob([serializeProject(project)], { type: 'application/json' }),
      `${project.title.trim() || 'project'}.asr.json`,
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
        toast.show({ kind: 'success', title: '프로젝트를 불러왔습니다', description: project.title });
      })().catch(failWith);
    },
    [refreshProjects, openProject, failWith, toast],
  );

  const exportDocument = async (format: ExportFormat) => {
    if (!currentDoc) return;
    try {
      const response = await fetch('/api/export', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ format, title, doc: currentDoc }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `내보내기 실패 (${response.status})`);
      }
      const blob = await response.blob();
      const filename = `${title.trim() || 'transcript'}.${format}`;
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
  };

  const busy = phase === 'splitting' || phase === 'transcribing';
  const topStatus =
    phase === 'splitting'
      ? '오디오를 나누는 중…'
      : phase === 'transcribing'
        ? mode === 'retry'
          ? `재인식 ${retryDone}/${retryTotal}`
          : `인식 ${assembled.readyCount}/${expectedCount ?? '…'}`
        : null;
  const editorStatus = phase === 'review' ? '검수 중' : busy ? '인식 중 · 편집 잠금' : '대기';
  const showEditor = editorValue !== null || phase !== 'idle';

  return (
    <div className={styles.shell}>
      <TopBar
        title={title}
        onTitleChange={setTitle}
        savedAt={phase === 'review' ? savedAt : null}
        status={topStatus}
        exportDisabled={phase !== 'review' || !currentDoc}
        onExport={exportDocument}
      />

      <div className={styles.body}>
        <Sidebar
          ref={sidebarRef}
          projects={projects}
          activeId={activeProject?.id ?? null}
          disabled={busy}
          onSelectAudio={start}
          onOpen={openProject}
          onDelete={removeProject}
          onExport={exportProject}
          onImport={importProject}
        />

        <main className={styles.main}>
          {showEditor ? (
            <Editor
              value={editorValue}
              editable={phase === 'review'}
              showTimestamps={showTimestamps}
              currentMs={currentMs}
              statusLabel={editorStatus}
              onChange={setDoc}
              onSeek={(ms) => playerRef.current?.seekTo(ms)}
              onRetryChunk={retryChunk}
              onToggleTimestamps={() => setShowTimestamps((v) => !v)}
            />
          ) : (
            <div className={styles.empty}>
              <span className={styles.emptyTitle}>오디오를 불러와 시작하세요</span>
              <span>mp3를 선택하면 인식이 시작되고, 결과는 이 브라우저에 프로젝트로 저장됩니다.</span>
            </div>
          )}
        </main>
      </div>

      <PlayerBar ref={playerRef} file={file} durationMs={durationMs} onTimeUpdate={setCurrentMs} />
    </div>
  );
};