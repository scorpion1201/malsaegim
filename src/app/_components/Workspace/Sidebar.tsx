'use client';

import Link from 'next/link';
import { forwardRef, useCallback, useImperativeHandle, useRef, useState } from 'react';
import type { ProjectMeta } from '@/app/_lib/editor/projectStore';
import type { ExportFormat } from '@/app/_lib/hwp/docModel';
import type { WorkspaceTab } from '@/app/_lib/settings/workspaceState';
import { formatDateTime, formatTimestamp } from '@/app/_lib/time';
import { pairLabel } from '@/app/_lib/translation/languages';
import { Menu, type MenuItem } from '../Menu/Menu';
import { ThemeToggle } from '../ThemeToggle/ThemeToggle';
import { GearIcon } from './GearIcon';
import styles from './Workspace.module.css';

export type SidebarHandle = {
  openAudioPicker: () => void;
  focusNewTranslation: () => void;
};

type SidebarProps = {
  tab: WorkspaceTab;
  projects: ProjectMeta[];
  activeId: string | null;
  /** 분할·인식·녹음 중에는 불러오기/열기/메뉴를 막는다 (녹음 토글은 예외) */
  disabled: boolean;
  recording: boolean;
  onSelectAudio: (file: File) => void;
  onImport: (file: File) => void;
  onToggleRecord: () => void;
  /** 스플릿 버튼 왼쪽(+ 새 노트북): 빈 노트를 만든다 */
  onNewNote: () => void;
  onOpen: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onExportJson: (id: string) => void;
  onExportDoc: (id: string, format: ExportFormat) => void;
  onDownloadAudio: (id: string) => void;
  onDelete: (id: string) => void;
  onNewTranslation: () => void;
  newTranslationOpen: boolean;
  translating: boolean;
  /** 진행 중 행의 상태 문구 (번역 중, 일시정지) */
  liveLabel: string;
  /** 연결 중에만 보이는 임시 행 — 실패하면 사라진다 */
  pendingRow: { title: string; meta: string } | null;
  /** 첫 스피커 세션의 이어폰 안내 */
  speakerHint: boolean;
};

type Tone = 'ok' | 'failed' | 'none' | 'live';

const statusOf = (project: ProjectMeta, live: boolean): { label: string; tone: Tone } => {
  if (live) return { label: '녹음 중', tone: 'live' };
  if (project.targetLanguage && project.totalChunks === 0) return { label: '완료', tone: 'ok' };
  if (project.totalChunks === 0) return { label: '텍스트만', tone: 'none' };
  // 실패 개수는 재인식 로직에서만 쓰고 목록에는 드러내지 않는다 — 점 색으로만 구분
  if (project.failedCount > 0) return { label: '미완료', tone: 'failed' };
  return { label: '완료', tone: 'ok' };
};

/** 예전 목록 항목에는 kind 가 없다 — audioName 으로 유추한다 */
const hasAudio = (project: ProjectMeta): boolean =>
  (project.kind ?? (project.audioName ? 'file' : 'text')) !== 'text';

const dotClass = (tone: Tone): string =>
  tone === 'failed' || tone === 'live' ? styles.dotFailed : tone === 'ok' ? styles.dotOk : styles.dotNone;

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const;

const PlusIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" {...stroke} strokeWidth={2}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

const ImportIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" {...stroke}>
    <path d="M12 16V4M7 9l5-5 5 5" />
    <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
  </svg>
);

const ChevronIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" {...stroke} strokeWidth={2}>
    <path d="M6 9l6 6 6-6" />
  </svg>
);

const AudioIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" {...stroke}>
    <path d="M9 18V6l11-2v12" />
    <circle cx="6" cy="18" r="3" />
    <circle cx="17" cy="16" r="3" />
  </svg>
);

const MicIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" {...stroke} strokeWidth={2}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8" />
  </svg>
);

const TranslateIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" {...stroke}>
    <path d="M4 5h9M8.5 3v2M11 5c-.8 3.6-3 6.6-7 8.5M5.5 8.5c1.2 2 3 3.7 5.5 5" />
    <path d="M12 21l4.5-10L21 21M13.6 18h5.8" />
  </svg>
);

const HeadphonesIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" {...stroke}>
    <path d="M4 15v-3a8 8 0 0 1 16 0v3" />
    <rect x="3" y="14" width="4" height="7" rx="1.5" />
    <rect x="17" y="14" width="4" height="7" rx="1.5" />
  </svg>
);

const DotsIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <circle cx="5" cy="12" r="1.8" />
    <circle cx="12" cy="12" r="1.8" />
    <circle cx="19" cy="12" r="1.8" />
  </svg>
);

const PencilIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" {...stroke}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </svg>
);

const DownloadIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" {...stroke}>
    <path d="M12 3v12M6 11l6 6 6-6" />
    <path d="M4 21h16" />
  </svg>
);

const DocIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" {...stroke}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5" />
  </svg>
);

const WaveIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" {...stroke}>
    <path d="M3 12h2l2-6 3 12 3-9 2 6 2-3h4" />
  </svg>
);

const TrashIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" {...stroke}>
    <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
  </svg>
);

export const Sidebar = forwardRef<SidebarHandle, SidebarProps>(
  (
    {
      tab,
      projects,
      activeId,
      disabled,
      recording,
      onSelectAudio,
      onImport,
      onToggleRecord,
      onNewNote,
      onOpen,
      onRename,
      onExportJson,
      onExportDoc,
      onDownloadAudio,
      onDelete,
      onNewTranslation,
      newTranslationOpen,
      translating,
      liveLabel,
      pendingRow,
      speakerHint,
    },
    ref,
  ) => {
    const audioInputRef = useRef<HTMLInputElement>(null);
    const importInputRef = useRef<HTMLInputElement>(null);
    const newTranslationRef = useRef<HTMLButtonElement>(null);
    const [loadOpen, setLoadOpen] = useState(false);
    const [menuId, setMenuId] = useState<string | null>(null);
    const [renamingId, setRenamingId] = useState<string | null>(null);
    const [draft, setDraft] = useState('');

    useImperativeHandle(ref, () => ({
      openAudioPicker: () => audioInputRef.current?.click(),
      focusNewTranslation: () => newTranslationRef.current?.focus(),
    }));

    const closeLoad = useCallback(() => setLoadOpen(false), []);
    const closeRowMenu = useCallback(() => setMenuId(null), []);

    const commitRename = (project: ProjectMeta) => {
      const next = draft.trim();
      setRenamingId(null);
      if (next.length > 0 && next !== project.title) onRename(project.id, next);
    };

    const loadItems: MenuItem[] = [
      { label: '노트 불러오기', icon: <ImportIcon />, onSelect: () => importInputRef.current?.click() },
      { label: '오디오 불러오기', icon: <AudioIcon />, onSelect: () => audioInputRef.current?.click() },
    ];

    const rowItems = (project: ProjectMeta): MenuItem[] => [
      {
        label: '이름 바꾸기',
        icon: <PencilIcon />,
        onSelect: () => {
          setDraft(project.title);
          setRenamingId(project.id);
        },
      },
      { label: '노트 내보내기 (JSON)', icon: <DownloadIcon />, onSelect: () => onExportJson(project.id) },
      { label: 'HWPX로 저장', icon: <DocIcon />, onSelect: () => onExportDoc(project.id, 'hwpx') },
      { label: 'HWP로 저장', icon: <DocIcon />, onSelect: () => onExportDoc(project.id, 'hwp') },
      ...(hasAudio(project)
        ? [{ label: '오디오 다운로드', icon: <WaveIcon />, onSelect: () => onDownloadAudio(project.id) }]
        : []),
      'separator',
      { label: '삭제', icon: <TrashIcon />, danger: true, onSelect: () => onDelete(project.id) },
    ];

    return (
      <aside className={styles.sidebar}>
        <input
          ref={audioInputRef}
          type="file"
          accept="audio/*"
          aria-label="오디오 불러오기"
          className={styles.hiddenInput}
          disabled={disabled}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) onSelectAudio(file);
            event.target.value = '';
          }}
        />
        <input
          ref={importInputRef}
          type="file"
          accept="application/json,.json"
          aria-label="노트 불러오기"
          className={styles.hiddenInput}
          disabled={disabled}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) onImport(file);
            event.target.value = '';
          }}
        />

        <div className={styles.drawerTop}>
          <ThemeToggle />
          {disabled ? null : (
            <Link href="/settings" className={styles.gearButton} aria-label="설정">
              <GearIcon />
            </Link>
          )}
        </div>

        {tab === 'translate' ? (
          <div className={styles.sidebarTop}>
            <button
              ref={newTranslationRef}
              type="button"
              className={translating ? styles.newTranslationLive : newTranslationOpen ? styles.newTranslationOpen : styles.newTranslation}
              disabled={disabled && !translating}
              data-tooltip={translating ? '번역 중. 누르면 중지' : undefined}
              onClick={(event) => {
                event.currentTarget.blur();
                if (translating) onToggleRecord();
                else onNewTranslation();
              }}
            >
              {translating ? (
                <span className={styles.pulse}>
                  <TranslateIcon />
                </span>
              ) : (
                <PlusIcon />
              )}
              <span>{translating ? '번역 중' : '새 번역'}</span>
            </button>
          </div>
        ) : (
          <div className={styles.sidebarTop}>
            <div className={styles.loadWrap}>
              {/* 한 버튼처럼 보이는 스플릿 버튼 — 왼쪽은 빈 노트북, 오른쪽 ▾ 만 불러오기 메뉴 */}
              <div className={styles.splitButton}>
                <button
                  type="button"
                  className={styles.splitMain}
                  disabled={disabled}
                  data-tooltip="빈 노트북 만들기"
                  onClick={onNewNote}
                >
                  <PlusIcon />
                  <span className={styles.loadLabel}>새 노트북</span>
                </button>
                <button
                  type="button"
                  className={styles.splitArrow}
                  disabled={disabled}
                  aria-label="불러오기 메뉴"
                  aria-haspopup="menu"
                  aria-expanded={loadOpen}
                  data-menu-toggle
                  onClick={() => setLoadOpen((open) => !open)}
                >
                  <ChevronIcon />
                </button>
              </div>
              <Menu open={loadOpen} items={loadItems} label="불러오기" className={styles.loadMenu} onClose={closeLoad} />
            </div>
            <button
              type="button"
              className={recording ? styles.recordButtonActive : styles.recordButton}
              disabled={!recording && disabled}
              aria-pressed={recording}
              aria-label={recording ? '녹음 중지' : '녹음 시작'}
              data-tooltip={recording ? '녹음 중 — 누르면 중지' : '녹음 시작'}
              onClick={(event) => {
                // 포커스를 남기면 Space(일시정지 단축키)가 이 버튼을 다시 눌러 녹음을 끝내 버린다
                event.currentTarget.blur();
                onToggleRecord();
              }}
            >
              {recording ? (
                <>
                  <span className={styles.pulse}>
                    <MicIcon />
                  </span>
                  <span>녹음 중</span>
                </>
              ) : (
                <MicIcon />
              )}
            </button>
          </div>
        )}

        <div className={styles.sectionLabel}>{tab === 'translate' ? '번역 노트' : '노트'}</div>

        <div className={styles.projectList}>
          {pendingRow ? (
            <div className={styles.projectRowActive}>
              <div className={styles.projectOpen}>
                <span className={styles.projectTitle}>{pendingRow.title}</span>
                <span className={styles.projectMeta}>
                  <span className={styles.dotFailed} />
                  <span>{pendingRow.meta}</span>
                </span>
              </div>
            </div>
          ) : null}
          {projects.length === 0 ? (
            pendingRow ? null : (
            <p className={styles.projectEmpty}>
              {tab === 'translate'
                ? '저장된 번역 노트가 없습니다. 새 번역을 시작하면 번역 노트가 생깁니다.'
                : '저장된 노트가 없습니다. 오디오를 불러오거나 녹음을 시작하면 새 노트가 생깁니다.'}
            </p>
            )
          ) : (
            projects.map((project) => {
              const active = project.id === activeId;
              const live = recording && active;
              const status = statusOf(project, live);
              const translationMeta = project.targetLanguage
                ? `${pairLabel(project.sourceLanguage ?? 'auto', project.targetLanguage)} · ${
                    live ? liveLabel : `${formatTimestamp(project.durationMs ?? 0)} · ${status.label}`
                  }`
                : null;
              const isRecording = (project.kind ?? 'file') === 'recording';
              const menuOpen = menuId === project.id;
              return (
                <div key={project.id} className={active ? styles.projectRowActive : styles.projectRow}>
                  {renamingId === project.id ? (
                    <input
                      className={styles.renameInput}
                      value={draft}
                      autoFocus
                      aria-label="노트 이름"
                      onChange={(event) => setDraft(event.target.value)}
                      onBlur={() => commitRename(project)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') commitRename(project);
                        if (event.key === 'Escape') setRenamingId(null);
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className={styles.projectOpen}
                      disabled={disabled}
                      onClick={() => onOpen(project.id)}
                    >
                      <span className={styles.projectTitle}>{project.title || '(제목 없음)'}</span>
                      <span className={styles.projectMeta}>
                        <span className={dotClass(status.tone)} />
                        <span>
                          {translationMeta ??
                            (isRecording
                            ? `녹음 · ${formatTimestamp(project.durationMs ?? 0)} · ${status.label}`
                            : `${formatDateTime(project.updatedAt)} · ${status.label}`)}
                        </span>
                      </span>
                    </button>
                  )}
                  <button
                    type="button"
                    className={menuOpen ? styles.dotsButtonOpen : styles.dotsButton}
                    disabled={disabled}
                    aria-label="더 보기"
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    data-menu-toggle
                    onClick={() => setMenuId(menuOpen ? null : project.id)}
                  >
                    <DotsIcon />
                  </button>
                  <Menu open={menuOpen} items={rowItems(project)} align="right" label="노트 메뉴" onClose={closeRowMenu} />
                </div>
              );
            })
          )}
        </div>

        {speakerHint ? (
          <div className={styles.speakerHint} role="status">
            <span className={styles.speakerHintIcon}>
              <HeadphonesIcon />
            </span>
            <div className={styles.speakerHintText}>
              <span className={styles.speakerHintTitle}>이어폰을 권장합니다</span>
              <span>스피커로 들으면 번역 음성이 마이크와 저장 녹음에 섞입니다.</span>
            </div>
          </div>
        ) : null}
      </aside>
    );
  },
);

Sidebar.displayName = 'Sidebar';