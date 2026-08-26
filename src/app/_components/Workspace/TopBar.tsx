'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { ExportFormat } from '@/app/_lib/hwp/docModel';
import { ThemeToggle } from '../ThemeToggle/ThemeToggle';
import styles from './Workspace.module.css';

type TopBarProps = {
  title: string;
  /** 열린 노트가 없으면(목록이 비었거나 아무것도 선택하지 않음) 제목 입력란을 숨긴다 */
  titleVisible: boolean;
  onTitleChange: (title: string) => void;
  /** 마지막 자동 저장 시각 (없으면 표시 안 함) */
  savedAt: number | null;
  /** 상단 바 가운데 상태 문구 (예: "인식 2/16") */
  status: string | null;
  /** live = 빨간 점이 깜박이는 필 (녹음 중) */
  statusTone?: 'muted' | 'live';
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

export const TopBar = ({
  title,
  titleVisible,
  onTitleChange,
  savedAt,
  status,
  statusTone = 'muted',
  exportDisabled,
  onExport,
}: TopBarProps) => {
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
    <header className={styles.topBar}>
      <div className={styles.topLeft}>
        <Link href="/" className={styles.logo} draggable={false} aria-label="말새김 홈">
          <Image src="/app-logo.png" alt="" width={44} height={44} priority draggable={false} className={styles.logoMark} />
          말새김
        </Link>
        {titleVisible ? (
          <label className={styles.titleField}>
            <input
              className={styles.titleInput}
              value={title}
              placeholder="노트 제목"
              aria-label="노트 제목"
              onChange={(event) => onTitleChange(event.target.value)}
              size={Math.max(8, Math.min(40, title.length + 2))}
            />
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
            </svg>
          </label>
        ) : null}
        {status && statusTone === 'live' ? (
          <span className={styles.livePill}>
            <span className={styles.liveDot} />
            {status}
          </span>
        ) : status ? (
          <span className={styles.status}>{status}</span>
        ) : null}
      </div>

      <div className={styles.topRight}>
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
          data-tooltip="HWP 5.0 문서로 저장"
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
        <div className={styles.themeSlot}>
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
};