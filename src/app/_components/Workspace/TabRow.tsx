'use client';

import { useEffect, useState } from 'react';
import type { ExportFormat } from '@/app/_lib/hwp/docModel';
import styles from './Workspace.module.css';

type TabRowProps = {
  /** 마지막 자동 저장 시각 (없으면 표시 안 함) */
  savedAt: number | null;
  exportDisabled: boolean;
  onExport: (format: ExportFormat) => Promise<void>;
};

const relative = (savedAt: number, now: number): string => {
  const seconds = Math.max(0, Math.round((now - savedAt) / 1000));
  if (seconds < 5) return '방금';
  if (seconds < 60) return `${seconds}초 전`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}분 전`;
  return `${Math.floor(minutes / 60)}시간 전`;
};

export const TabRow = ({ savedAt, exportDisabled, onExport }: TabRowProps) => {
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState<ExportFormat | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, []);

  const run = async (format: ExportFormat) => {
    setBusy(format);
    try {
      await onExport(format);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={styles.tabRow}>
      <nav className={styles.tabs} aria-label="기능">
        <span className={styles.tabIndicator} style={{ width: 96 }} aria-hidden="true" />
        <button type="button" className={styles.tabActive} style={{ width: 96 }} aria-current="page">
          받아쓰기
        </button>
      </nav>
      <div className={styles.saveGroup}>
        {savedAt !== null ? (
          <span className={styles.saved}>
            <span className={styles.savedDot} />
            자동 저장됨 · {relative(savedAt, now)}
          </span>
        ) : null}
        <button
          type="button"
          className={styles.secondaryButton}
          disabled={exportDisabled || busy !== null}
          onClick={() => void run('hwp')}
          data-tooltip="HWP 문서로 저장"
        >
          {busy === 'hwp' ? '생성 중…' : 'HWP'}
        </button>
        <button
          type="button"
          className={styles.primaryButton}
          disabled={exportDisabled || busy !== null}
          onClick={() => void run('hwpx')}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 3v12M6 11l6 6 6-6" />
            <path d="M4 21h16" />
          </svg>
          <span>{busy === 'hwpx' ? '생성 중…' : 'HWPX 저장'}</span>
        </button>
      </div>
    </div>
  );
};