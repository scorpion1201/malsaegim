'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { assembleTranscript, type ChunkOutcome } from '@/app/_lib/asr/assembleTranscript';
import { CLIENT_CONCURRENCY, createTranscribeQueue, type TranscribeQueue } from '@/app/_lib/asr/transcribeQueue';
import { sha256Hex } from '@/app/_lib/audio/fileHash';
import { extractAudioRanges, splitAudioBuffer, type SplitHandle } from '@/app/_lib/audio/splitAudioFile';
import { DEFAULT_SPLIT_OPTIONS, type ExtractRange } from '@/app/_lib/audio/types';
import { blocksToTiptapDoc } from '@/app/_lib/editor/blocksToTiptapDoc';
import { patchFailedParagraph } from '@/app/_lib/editor/patchTranscript';
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
import { AudioPlayer, type AudioPlayerHandle } from '../AudioPlayer/AudioPlayer';
import { Editor } from '../Editor/Editor';
import { ExportBar } from './ExportBar';
import { ProjectPanel } from './ProjectPanel';
import { TranscribeProgress } from './TranscribeProgress';
import { Uploader } from './Uploader';
import styles from './Workspace.module.css';

type Phase = 'idle' | 'splitting' | 'transcribing' | 'review' | 'error';
type RunMode = 'new' | 'retry';

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

export const TranscribeWorkspace = () => {
  const [phase, setPhase] = useState<Phase>('idle');
  const [mode, setMode] = useState<RunMode>('new');
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [outcomes, setOutcomes] = useState<Map<number, ChunkOutcome>>(new Map());
  const [expectedCount, setExpectedCount] = useState<number | null>(null);
  const [durationMs, setDurationMs] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [editorValue, setEditorValue] = useState<TiptapDoc | null>(null);
  const [currentDoc, setCurrentDoc] = useState<TiptapDoc | null>(null);
  const [currentMs, setCurrentMs] = useState(0);
  const [showTimestamps, setShowTimestamps] = useState(true);
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [retryDone, setRetryDone] = useState(0);
  const [retryTotal, setRetryTotal] = useState(0);

  const playerRef = useRef<AudioPlayerHandle>(null);
  const splitRef = useRef<SplitHandle | null>(null);
  const queueRef = useRef<TranscribeQueue | null>(null);
  const docRef = useRef<TiptapDoc | null>(null);
  const activeRef = useRef<Project | null>(null);
  const pendingAudioRef = useRef<ProjectAudio | null>(null);

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

  // 조립 결과 → 에디터 (새 인식 중에만 갱신 — 재인식은 placeholder 패치로 처리)
  useEffect(() => {
    if (mode !== 'new' || (phase !== 'transcribing' && phase !== 'splitting')) return;
    const doc = blocksToTiptapDoc(assembled.blocks);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setEditorValue(doc);
    setDoc(doc);
  }, [assembled, phase, mode, setDoc]);

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
    saveProject(window.localStorage, project);
    setPhase('review');
    refreshProjects();
  }, [mode, phase, assembled, outcomes, title, setActive, refreshProjects]);

  // 최초 진입: 예전 단일 초안 마이그레이션 + 목록 로드 + 최근 프로젝트 자동 열기
  useEffect(() => {
    migrateLegacyDraft(window.localStorage);
    const metas = listProjects(window.localStorage);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setProjects(metas);
    if (metas.length > 0) {
      const recent = loadProject(window.localStorage, metas[0].id);
      if (recent) {
        setActive(recent);
        setTitle(recent.title);
        setEditorValue(recent.doc);
        setDoc(recent.doc);
        setDurationMs(recent.audio?.durationMs ?? null);
        setExpectedCount(recent.chunks.length > 0 ? recent.chunks.length : null);
        setPhase('review');
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 검수 단계 자동 저장 (500ms 디바운스)
  useEffect(() => {
    if (phase !== 'review' || !currentDoc || !activeProject) return;
    const timer = setTimeout(() => {
      const updated: Project = { ...activeProject, title, doc: currentDoc, updatedAt: Date.now() };
      activeRef.current = updated;
      saveProject(window.localStorage, updated);
      setProjects((previous) => [toMeta(updated), ...previous.filter((meta) => meta.id !== updated.id)]);
    }, 500);
    return () => clearTimeout(timer);
  }, [phase, currentDoc, title, activeProject]);

  const stop = useCallback(() => {
    splitRef.current?.cancel();
    queueRef.current?.abort();
    splitRef.current = null;
    queueRef.current = null;
  }, []);

  useEffect(() => stop, [stop]);

  const failWith = useCallback(
    (error: unknown) => {
      setErrorMessage(error instanceof Error ? error.message : String(error));
      setPhase('error');
      stop();
    },
    [stop],
  );

  const makeQueue = useCallback(
    (onOutcome: (outcome: ChunkOutcome) => void) =>
      createTranscribeQueue(
        { concurrency: CLIENT_CONCURRENCY, maxRetries: 3 },
        {
          onOutcome,
          onFatal: (error) => {
            failWith(
              error.message.includes('401') ? new Error('로그인이 만료되었습니다. 새로고침하세요.') : error,
            );
          },
        },
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
      setFile(selected);
      setTitle(stripExtension(selected.name));
      setOutcomes(new Map());
      setExpectedCount(null);
      setDurationMs(null);
      setErrorMessage(null);
      setEditorValue(null);
      setDoc(null);
      setPhase('splitting');

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
    [stop, setActive, setDoc, makeQueue, failWith],
  );

  /** 재인식: 저장된 시간 구간만 추출해 실패 조각만 다시 보낸다 */
  const beginRetry = useCallback(
    (buffer: ArrayBuffer, failed: StoredChunk[], project: Project) => {
      stop();
      setMode('retry');
      setErrorMessage(null);
      setRetryDone(0);
      setRetryTotal(failed.length);
      setPhase('transcribing');

      const queue = makeQueue((outcome) => {
        setRetryDone((done) => done + 1);
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
            console.warn(
              `[retry] 디코드 길이가 저장값과 다릅니다: stored=${stored}ms decoded=${summary.totalMs}ms`,
            );
          }
          return queue.close();
        })
        .then(() => {
          const current = activeRef.current;
          if (current) {
            const updated: Project = {
              ...current,
              doc: docRef.current ?? current.doc,
              updatedAt: Date.now(),
            };
            setActive(updated);
            saveProject(window.localStorage, updated);
            refreshProjects();
          }
          setMode('new');
          setPhase('review');
        })
        .catch(failWith);
    },
    [stop, makeQueue, setActive, refreshProjects, failWith],
  );

  /** 파일 선택: 같은 mp3 면 재생 연결·부분 재인식, 다른 파일이면 새 프로젝트 */
  const start = useCallback(
    (selected: File) => {
      void (async () => {
        const buffer = await selected.arrayBuffer();
        const sha256 = await sha256Hex(buffer); // transfer 전에 해시부터
        const active = activeRef.current;

        if (active?.audio && active.audio.sha256 === sha256) {
          setFile(selected);
          setDurationMs(active.audio.durationMs);
          const failed = active.chunks.filter((chunk) => chunk.status === 'failed');
          if (failed.length > 0) beginRetry(buffer, failed, active);
          return;
        }

        if (active) {
          const proceed = window.confirm(
            '열려 있는 프로젝트와 다른 파일입니다. 새 프로젝트로 시작할까요?',
          );
          if (!proceed) return;
        }
        beginNew(selected, buffer, sha256);
      })().catch(failWith);
    },
    [beginNew, beginRetry, failWith],
  );

  const cancel = useCallback(() => {
    stop();
    setMode('new');
    setPhase(outcomes.size > 0 || currentDoc ? 'review' : 'idle');
    setExpectedCount(outcomes.size);
  }, [stop, outcomes.size, currentDoc]);

  const resetWorkspace = useCallback(() => {
    stop();
    setActive(null);
    setFile(null);
    setTitle('');
    setOutcomes(new Map());
    setExpectedCount(null);
    setDurationMs(null);
    setEditorValue(null);
    setDoc(null);
    setPhase('idle');
  }, [stop, setActive, setDoc]);

  const openProject = useCallback(
    (id: string) => {
      const project = loadProject(window.localStorage, id);
      if (!project) return;
      stop();
      setMode('new');
      setActive(project);
      setFile(null);
      setTitle(project.title);
      setEditorValue(project.doc);
      setDoc(project.doc);
      setOutcomes(new Map());
      setExpectedCount(project.chunks.length > 0 ? project.chunks.length : null);
      setDurationMs(project.audio?.durationMs ?? null);
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
    },
    [refreshProjects, resetWorkspace],
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
          window.alert('가져올 수 없는 파일입니다. 이 앱에서 내보낸 .asr.json 인지 확인하세요.');
          return;
        }
        saveProject(window.localStorage, project);
        refreshProjects();
        openProject(project.id);
      })().catch(failWith);
    },
    [refreshProjects, openProject, failWith],
  );

  const exportDocument = async (format: ExportFormat) => {
    if (!currentDoc) throw new Error('내보낼 내용이 없습니다');
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
    downloadBlob(blob, `${title.trim() || 'transcript'}.${format}`);
  };

  const busy = phase === 'splitting' || phase === 'transcribing';

  return (
    <main className={styles.main}>
      <header className={styles.header}>
        <h1 className={styles.title}>말새김</h1>
        <Uploader disabled={busy} fileName={file?.name ?? null} onSelect={start} />
      </header>

      <ProjectPanel
        projects={projects}
        activeId={activeProject?.id ?? null}
        disabled={busy}
        onOpen={openProject}
        onDelete={removeProject}
        onExport={exportProject}
        onImport={importProject}
      />

      {phase !== 'review' || expectedCount !== null ? (
        <TranscribeProgress
          phase={phase}
          readyCount={
            phase === 'review'
              ? (expectedCount ?? 0)
              : mode === 'retry'
                ? retryDone
                : assembled.readyCount
          }
          heldCount={mode === 'retry' ? 0 : assembled.heldCount}
          totalCount={mode === 'retry' && phase !== 'review' ? retryTotal : expectedCount}
          errorMessage={errorMessage}
          onCancel={cancel}
        />
      ) : null}

      <section className={styles.player}>
        <AudioPlayer
          ref={playerRef}
          file={file}
          currentMs={currentMs}
          durationMs={durationMs}
          onTimeUpdate={setCurrentMs}
        />
      </section>

      <section className={styles.editor}>
        <Editor
          value={editorValue}
          editable={phase === 'review'}
          showTimestamps={showTimestamps}
          currentMs={currentMs}
          onChange={setDoc}
          onSeek={(ms) => playerRef.current?.seekTo(ms)}
          onToggleTimestamps={() => setShowTimestamps((v) => !v)}
        />
      </section>

      <ExportBar
        title={title}
        disabled={phase !== 'review'}
        onTitleChange={setTitle}
        onExport={exportDocument}
      />
    </main>
  );
};