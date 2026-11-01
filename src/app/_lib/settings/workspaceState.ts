import type { ProjectMeta } from '@/app/_lib/editor/projectStore';

export type WorkspaceTab = 'transcribe' | 'translate';
export type WorkspaceState = { tab: WorkspaceTab; lastNote: Partial<Record<WorkspaceTab, string>> };

const STORAGE_KEY = 'malsaegim:workspace';

export const TAB_LABEL: Record<WorkspaceTab, string> = { transcribe: '받아쓰기', translate: '실시간 번역' };

const noteId = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

export const readWorkspaceState = (): WorkspaceState => {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { tab: 'transcribe', lastNote: {} };
    const parsed = JSON.parse(raw) as { tab?: unknown; lastNote?: { transcribe?: unknown; translate?: unknown } | null };
    return {
      tab: parsed.tab === 'translate' ? 'translate' : 'transcribe',
      lastNote: { transcribe: noteId(parsed.lastNote?.transcribe), translate: noteId(parsed.lastNote?.translate) },
    };
  } catch {
    return { tab: 'transcribe', lastNote: {} };
  }
};

export const writeWorkspaceState = (state: WorkspaceState): void => {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 저장 실패는 조용히 무시 — 복귀 위치만 잃는다
  }
};

export const tabOfMeta = (meta: Pick<ProjectMeta, 'targetLanguage'>): WorkspaceTab =>
  meta.targetLanguage ? 'translate' : 'transcribe';