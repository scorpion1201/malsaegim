'use client';

import { useEffect, useState } from 'react';
import {
  applyThemePreference,
  readThemePreference,
  saveThemePreference,
  type ThemePreference,
} from '@/app/_lib/theme';
import styles from './ThemeToggle.module.css';

const OPTIONS: Array<{ key: ThemePreference; label: string }> = [
  { key: 'system', label: '시스템 설정 따르기' },
  { key: 'light', label: '라이트' },
  { key: 'dark', label: '다크' },
];

const Icon = ({ kind }: { kind: ThemePreference }) => {
  if (kind === 'system') {
    return (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="4" width="18" height="12" rx="2" />
        <path d="M8 20h8M12 16v4" />
      </svg>
    );
  }
  if (kind === 'light') {
    return (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
    );
  }
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
    </svg>
  );
};

export const ThemeToggle = () => {
  const [preference, setPreference] = useState<ThemePreference>('system');

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPreference(readThemePreference(window.localStorage));
  }, []);

  const choose = (next: ThemePreference) => {
    setPreference(next);
    applyThemePreference(next);
    saveThemePreference(window.localStorage, next);
  };

  return (
    <div className={styles.group} role="radiogroup" aria-label="테마">
      {OPTIONS.map((option) => (
        <button
          key={option.key}
          type="button"
          role="radio"
          aria-checked={preference === option.key}
          aria-label={option.label}
          data-tooltip={option.label}
          className={preference === option.key ? styles.segmentActive : styles.segment}
          onClick={() => choose(option.key)}
        >
          <Icon kind={option.key} />
        </button>
      ))}
    </div>
  );
};