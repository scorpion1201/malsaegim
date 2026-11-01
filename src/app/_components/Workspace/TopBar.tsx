'use client';

import Image from 'next/image';
import Link from 'next/link';
import { ThemeToggle } from '../ThemeToggle/ThemeToggle';
import { GearIcon } from './GearIcon';
import styles from './Workspace.module.css';

type TopBarProps = {
  title: string;
  /** 열린 노트가 없으면(목록이 비었거나 아무것도 선택하지 않음) 제목 입력란을 숨긴다 */
  titleVisible: boolean;
  onTitleChange: (title: string) => void;
  /** 진행 중에는 설정으로 나갈 수 없다 */
  navLocked: boolean;
};

export const TopBar = ({ title, titleVisible, onTitleChange, navLocked }: TopBarProps) => (
  <header className={styles.topBar}>
    <div className={styles.topLeft}>
      <Link href="/" className={styles.logo} draggable={false} aria-label="말새김 홈">
        <Image src="/app-logo.png" alt="" width={44} height={44} priority draggable={false} className={styles.logoMark} />
        말새김
      </Link>
    </div>

    {titleVisible ? (
      <div className={styles.titleSlot}>
        <label className={styles.titleField}>
          <input
            className={styles.titleInput}
            value={title}
            placeholder="노트 제목"
            aria-label="노트 제목"
            onChange={(event) => onTitleChange(event.target.value)}
            size={Math.max(8, Math.min(40, title.length * 2))}
          />
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
          </svg>
        </label>
      </div>
    ) : null}

    <div className={styles.topRight}>
      <div className={styles.themeSlot}>
        <ThemeToggle />
      </div>
      {navLocked ? (
        <button
          type="button"
          className={`${styles.gearButton} ${styles.gearButtonLocked}`}
          aria-label="설정"
          aria-disabled="true"
          data-tooltip="녹음을 끝낸 뒤 열 수 있습니다"
        >
          <GearIcon />
        </button>
      ) : (
        <Link href="/settings" className={styles.gearButton} aria-label="설정" data-tooltip="설정">
          <GearIcon />
        </Link>
      )}
    </div>
  </header>
);