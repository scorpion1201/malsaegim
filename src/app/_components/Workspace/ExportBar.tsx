'use client';

import { useState } from 'react';
import type { ExportFormat } from '@/app/_lib/hwp/docModel';
import styles from './Workspace.module.css';

type ExportBarProps = {
  title: string;
  disabled: boolean;
  onTitleChange: (title: string) => void;
  onExport: (format: ExportFormat) => Promise<void>;
};

export const ExportBar = ({ title, disabled, onTitleChange, onExport }: ExportBarProps) => {
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (format: ExportFormat) => {
    setBusy(format);
    setError(null);
    try {
      await onExport(format);
       } catch (e) {
      setError(e instanceof Error ? e.message : '내보내기 실패');
       } finally {
      setBusy(null);
       }
    };

  return (
       <div className={styles.exportBar}>
          <label className={styles.titleLabel}>
            제목
            <input
            className={styles.titleInput}
            value={title}
            onChange={(event) => onTitleChange(event.target.value)}
            placeholder="문서 제목 (파일 이름으로도 사용)"
            />
          </label>
          <button
          type="button"
          className={styles.exportButton}
          disabled={disabled || busy !== null}
          onClick={() => run('hwp')}
          >
            {busy === 'hwp' ? '생성 중…' : 'HWP 저장'}
          </button>
          <button
          type="button"
          className={styles.exportButton}
          disabled={disabled || busy !== null}
          onClick={() => run('hwpx')}
          >
            {busy === 'hwpx' ? '생성 중…' : 'HWPX 저장'}
          </button>
          {error ? <span className={styles.exportError}>{error}</span> : null}
       </div>
     );
};