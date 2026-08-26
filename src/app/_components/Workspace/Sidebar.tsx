'use client';

import { forwardRef, useImperativeHandle, useRef } from 'react';
import type { ProjectMeta } from '@/app/_lib/editor/projectStore';
import styles from './Workspace.module.css';

export type SidebarHandle = {
  openAudioPicker: () => void;
};

type SidebarProps = {
  projects: ProjectMeta[];
  activeId: string | null;
  disabled: boolean;
  onSelectAudio: (file: File) => void;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onExport: (id: string) => void;
  onImport: (file: File) => void;
};

const pad = (n: number) => String(n).padStart(2, '0');

const formatDate = (ms: number): string => {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

const statusOf = (project: ProjectMeta): { label: string; tone: 'ok' | 'failed' | 'none' } => {
  if (project.totalChunks === 0) return { label: '텍스트만', tone: 'none' };
  if (project.failedCount > 0)
    return { label: `실패 ${project.failedCount}/${project.totalChunks}`, tone: 'failed' };
  return { label: `완료 · ${project.totalChunks}조각`, tone: 'ok' };
};

export const Sidebar = forwardRef<SidebarHandle, SidebarProps>(
  ({ projects, activeId, disabled, onSelectAudio, onOpen, onDelete, onExport, onImport }, ref) => {
    const audioInputRef = useRef<HTMLInputElement>(null);
    const importInputRef = useRef<HTMLInputElement>(null);

    useImperativeHandle(ref, () => ({
      openAudioPicker: () => audioInputRef.current?.click(),
    }));

    return (
      <aside className={styles.sidebar}>
        <div className={styles.sidebarTop}>
          <input
            ref={audioInputRef}
            type="file"
            accept="audio/mpeg,.mp3"
            aria-label="오디오 불러오기"
            className={styles.hiddenInput}
            disabled={disabled}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) onSelectAudio(file);
              event.target.value = '';
            }}
          />
          <button
            type="button"
            className={styles.loadAudio}
            disabled={disabled}
            onClick={() => audioInputRef.current?.click()}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
            <span>오디오 불러오기</span>
          </button>
        </div>

        <div className={styles.sectionLabel}>프로젝트</div>

        <div className={styles.projectList}>
          {projects.length === 0 ? (
            <p className={styles.projectEmpty}>저장된 프로젝트가 없습니다. 오디오를 불러오면 새 프로젝트가 시작됩니다.</p>
          ) : (
            projects.map((project) => {
              const status = statusOf(project);
              const active = project.id === activeId;
              return (
                <div key={project.id} className={active ? styles.projectRowActive : styles.projectRow}>
                  <button
                    type="button"
                    className={styles.projectOpen}
                    disabled={disabled}
                    onClick={() => onOpen(project.id)}
                  >
                    <span className={styles.projectTitle}>{project.title || '(제목 없음)'}</span>
                    <span className={styles.projectMeta}>
                      <span
                        className={
                          status.tone === 'failed'
                            ? styles.dotFailed
                            : status.tone === 'ok'
                              ? styles.dotOk
                              : styles.dotNone
                        }
                      />
                      <span>
                        {formatDate(project.updatedAt)} · {status.label}
                      </span>
                    </span>
                  </button>
                  <div className={styles.projectActions}>
                    <button
                      type="button"
                      className={styles.iconButton}
                      disabled={disabled}
                      aria-label="프로젝트 내보내기"
                      data-tooltip="JSON으로 내보내기"
                      onClick={() => onExport(project.id)}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M12 3v12M6 11l6 6 6-6" />
                        <path d="M4 21h16" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      className={styles.iconButtonDanger}
                      disabled={disabled}
                      aria-label="프로젝트 삭제"
                      data-tooltip="삭제"
                      onClick={() => onDelete(project.id)}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
                      </svg>
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>

        <div className={styles.sidebarBottom}>
          <input
            ref={importInputRef}
            type="file"
            accept="application/json,.json"
            aria-label="프로젝트 불러오기"
            className={styles.hiddenInput}
            disabled={disabled}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) onImport(file);
              event.target.value = '';
            }}
          />
          <button
            type="button"
            className={styles.quietButton}
            disabled={disabled}
            onClick={() => importInputRef.current?.click()}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 21V9M6 15l6-6 6 6" />
              <path d="M4 3h16" />
            </svg>
            <span>프로젝트 불러오기</span>
          </button>
        </div>
      </aside>
    );
  },
);

Sidebar.displayName = 'Sidebar';