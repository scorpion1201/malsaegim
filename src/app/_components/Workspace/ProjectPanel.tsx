'use client';

import { useRef } from 'react';
import type { ProjectMeta } from '@/app/_lib/editor/projectStore';
import styles from './Workspace.module.css';

type ProjectPanelProps = {
  projects: ProjectMeta[];
  activeId: string | null;
  disabled: boolean;
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

const statusLabel = (project: ProjectMeta): string => {
  if (project.totalChunks === 0) return '';
  return project.failedCount > 0 ? ` · 실패 ${project.failedCount}/${project.totalChunks}` : ' · 완료';
};

export const ProjectPanel = ({
  projects,
  activeId,
  disabled,
  onOpen,
  onDelete,
  onExport,
  onImport,
}: ProjectPanelProps) => {
  const importRef = useRef<HTMLInputElement>(null);

  return (
    <details className={styles.projectPanel} open={projects.length > 0 && activeId === null}>
      <summary className={styles.projectSummary}>
        <span>프로젝트{projects.length > 0 ? ` (${projects.length})` : ''}</span>
        <span className={styles.projectImport}>
          <input
            ref={importRef}
            type="file"
            accept="application/json,.json"
            aria-label="프로젝트 JSON 가져오기"
            className={styles.fileInput}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) onImport(file);
              event.target.value = '';
            }}
          />
          <button
            type="button"
            className={styles.projectAction}
            disabled={disabled}
            onClick={(event) => {
              event.preventDefault();
              importRef.current?.click();
            }}
          >
            JSON 가져오기
          </button>
        </span>
      </summary>
      {projects.length === 0 ? (
        <p className={styles.projectEmpty}>
          저장된 프로젝트가 없습니다. mp3를 선택하면 새 프로젝트가 시작됩니다.
        </p>
      ) : (
        <ul className={styles.projectList}>
          {projects.map((project) => (
            <li
              key={project.id}
              className={project.id === activeId ? styles.projectRowActive : styles.projectRow}
            >
              <div className={styles.projectInfo}>
                <span className={styles.projectTitle}>{project.title || '(제목 없음)'}</span>
                <span className={styles.projectMetaLine}>
                  {formatDate(project.updatedAt)}
                  {project.audioName ? ` · ${project.audioName}` : ''}
                  {statusLabel(project)}
                </span>
              </div>
              <div className={styles.projectActions}>
                <button
                  type="button"
                  className={styles.projectAction}
                  disabled={disabled}
                  onClick={() => onOpen(project.id)}
                >
                  열기
                </button>
                <button
                  type="button"
                  className={styles.projectAction}
                  disabled={disabled}
                  onClick={() => onExport(project.id)}
                >
                  내보내기
                </button>
                <button
                  type="button"
                  className={styles.projectActionDanger}
                  disabled={disabled}
                  onClick={() => onDelete(project.id)}
                >
                  삭제
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
};