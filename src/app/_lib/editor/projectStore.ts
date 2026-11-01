import type { SplitOptions } from '@/app/_lib/audio/types';
import type { PageLayout } from '@/app/_lib/hwp/pageLayout';
import type { TiptapDoc } from '@/app/_lib/hwp/tiptapToDocModel';
import { isValidNoteDoc, isValidTranslationInfo } from './noteSchema';

export type ChunkStatus = 'ok' | 'failed';

export type StoredChunk = {
  index: number;
  startMs: number;
  endMs: number;
  status: ChunkStatus;
};

export type ProjectAudioKind = 'file' | 'recording';

export type ProjectAudio = {
  name: string;
  size: number;
  sha256: string;
  durationMs: number;
  /** 없으면 'file' (예전 노트). 'recording' 은 WAV 원본이 IndexedDB(recordings) 에 있다 */
  kind?: ProjectAudioKind;
  mimeType?: string;
};

export type Project = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** localStorage 에는 텍스트만 — 파일 노트는 재선택 시 sha256 으로 동일성만 확인하고, 녹음 노트는 WAV 를 IndexedDB 에 둔다 */
  audio: ProjectAudio | null;
  /** 최초 인식에 쓴 분할 옵션 (참고용 — 재인식은 chunks 의 시간 구간을 정본으로 쓴다) */
  splitOptions: SplitOptions | null;
  chunks: StoredChunk[];
  doc: TiptapDoc;
  /** 문서 레이아웃 — 없으면 기본 편집 용지(A4 세로). 내보낼 때 normalizePageLayout 으로 메운다 */
  layout?: PageLayout;
  /** 번역 노트 — sourceLanguage 는 코드 또는 'auto' */
  translation?: { sourceLanguage: string; targetLanguage: string; model: 'gpt-realtime-translate' };
};

export type ProjectMeta = {
  id: string;
  title: string;
  updatedAt: number;
  totalChunks: number;
  failedCount: number;
  audioName: string | null;
  /** 예전 목록 항목에는 없을 수 있다 — 없으면 'file' 로 본다 */
  kind?: 'file' | 'recording' | 'text';
  durationMs?: number | null;
  sourceLanguage?: string;
  /** 있으면 번역 노트 */
  targetLanguage?: string;
};

export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const INDEX_KEY = 'malsaegim:projects';
/** 가져올 노트 파일의 크기 상한 — 파일을 읽은 문자열 길이 기준 */
const MAX_IMPORT_LENGTH = 20_000_000;
const LEGACY_DRAFT_KEY = 'malsaegim:draft';
const projectKey = (id: string): string => `malsaegim:project:${id}`;

const isDoc = (value: unknown): value is TiptapDoc =>
  typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'doc';

const isChunk = (value: unknown): value is StoredChunk => {
  if (typeof value !== 'object' || value === null) return false;
  const chunk = value as StoredChunk;
  return (
    typeof chunk.index === 'number' &&
    typeof chunk.startMs === 'number' &&
    typeof chunk.endMs === 'number' &&
    (chunk.status === 'ok' || chunk.status === 'failed')
  );
};

const isProject = (value: unknown): value is Project => {
  if (typeof value !== 'object' || value === null) return false;
  const project = value as Project;
  return (
    typeof project.id === 'string' &&
    typeof project.title === 'string' &&
    typeof project.updatedAt === 'number' &&
    Array.isArray(project.chunks) &&
    project.chunks.every(isChunk) &&
    isDoc(project.doc)
  );
};

export const audioKindOf = (audio: ProjectAudio | null | undefined): 'file' | 'recording' | 'text' =>
  audio ? (audio.kind ?? 'file') : 'text';

export const toMeta = (project: Project): ProjectMeta => ({
  id: project.id,
  title: project.title,
  updatedAt: project.updatedAt,
  totalChunks: project.chunks.length,
  failedCount: project.chunks.filter((chunk) => chunk.status === 'failed').length,
  audioName: project.audio?.name ?? null,
  kind: audioKindOf(project.audio),
  durationMs: project.audio?.durationMs ?? null,
  sourceLanguage: project.translation?.sourceLanguage,
  targetLanguage: project.translation?.targetLanguage,
});

const readIndex = (storage: StorageLike): ProjectMeta[] => {
  try {
    const raw = storage.getItem(INDEX_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is ProjectMeta =>
        typeof entry === 'object' && entry !== null && typeof (entry as ProjectMeta).id === 'string',
    );
  } catch {
    return [];
  }
};

const writeIndex = (storage: StorageLike, metas: ProjectMeta[]): void => {
  try {
    storage.setItem(INDEX_KEY, JSON.stringify(metas));
  } catch {
    // 저장 실패는 조용히 무시 — 목록은 편의 기능
  }
};

export const listProjects = (storage: StorageLike): ProjectMeta[] =>
  readIndex(storage).sort((a, b) => b.updatedAt - a.updatedAt);

export const loadProject = (storage: StorageLike, id: string): Project | null => {
  try {
    const raw = storage.getItem(projectKey(id));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isProject(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

export const saveProject = (storage: StorageLike, project: Project): void => {
  try {
    storage.setItem(projectKey(project.id), JSON.stringify(project));
  } catch {
    return; // 본문 저장 실패 시 목록도 갱신하지 않는다
  }
  const rest = readIndex(storage).filter((meta) => meta.id !== project.id);
  writeIndex(storage, [toMeta(project), ...rest]);
};

export const deleteProject = (storage: StorageLike, id: string): void => {
  try {
    storage.removeItem(projectKey(id));
  } catch {
    // ignore
  }
  writeIndex(storage, readIndex(storage).filter((meta) => meta.id !== id));
};

export const newProjectId = (): string => crypto.randomUUID();

/** 예전 단일 초안(malsaegim:draft)을 노트 하나로 옮긴다. 노트가 이미 있으면 건드리지 않는다. */
export const migrateLegacyDraft = (storage: StorageLike): void => {
  try {
    const raw = storage.getItem(LEGACY_DRAFT_KEY);
    if (!raw || readIndex(storage).length > 0) return;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return;
    const legacy = parsed as { title?: unknown; doc?: unknown; savedAt?: unknown };
    if (!isDoc(legacy.doc)) return;
    const now = typeof legacy.savedAt === 'number' ? legacy.savedAt : 0;
    saveProject(storage, {
      id: newProjectId(),
      title: typeof legacy.title === 'string' ? legacy.title : '',
      createdAt: now,
      updatedAt: now,
      audio: null,
      splitOptions: null,
      chunks: [],
      doc: legacy.doc,
    });
    storage.removeItem(LEGACY_DRAFT_KEY);
  } catch {
    // 손상된 초안은 무시
  }
};

/** 내보내기: 노트 1개 = JSON 파일 1개 (녹음 원본은 포함하지 않는다) */
export const serializeProject = (project: Project): string => JSON.stringify(project, null, 2);

/** 가져오기: 검증 후 새 id 로 복제 (파일 출처와 무관하게 로컬 목록에서 유일하게) */
export const parseProjectFile = (text: string, now: number): Project | null => {
  try {
    if (text.length > MAX_IMPORT_LENGTH) return null;
    const parsed: unknown = JSON.parse(text);
    if (!isProject(parsed) || !isValidNoteDoc(parsed.doc) || !isValidTranslationInfo(parsed.translation)) return null;
    return { ...parsed, id: newProjectId(), updatedAt: now };
  } catch {
    return null;
  }
};