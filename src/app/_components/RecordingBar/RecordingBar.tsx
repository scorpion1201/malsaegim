'use client';

import { useEffect, useRef, type RefObject } from 'react';
import { formatTimestamp } from '@/app/_lib/time';
import styles from './RecordingBar.module.css';

export type RecordingBarProps = {
  elapsedMs: number;
  paused: boolean;
  /** 100ms 프레임별 RMS — 훅이 채우고 여기서는 rAF 로 읽기만 한다 (상태로 두면 초당 10번 리렌더) */
  levelsRef: RefObject<number[]>;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
};

/** 글을 입력 중이거나 버튼에 포커스가 있으면 단축키를 가로채지 않는다 */
const shouldIgnoreKey = (target: EventTarget | null): boolean => {
  // 열린 다이얼로그의 Esc 가 녹음을 멈추면 안 된다
  if (document.querySelector('[aria-modal="true"]')) return true;
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    tag === 'BUTTON' ||
    tag === 'A' ||
    target.isContentEditable
  );
};

const BAR_WIDTH = 3;
const BAR_GAP = 3;
const MIN_HEIGHT = 3;
const MAX_HEIGHT = 22;

/** RMS → 막대 높이. -60dB 이하는 바닥, 0dB 는 최대 */
const levelToHeight = (rms: number): number => {
  const db = 20 * Math.log10(rms + 1e-9);
  const ratio = Math.max(0, Math.min(1, (db + 60) / 60));
  return MIN_HEIGHT + (MAX_HEIGHT - MIN_HEIGHT) * ratio;
};

export const RecordingBar = ({ elapsedMs, paused, levelsRef, onPause, onResume, onStop }: RecordingBarProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // 파형: 트랙 너비를 3px 막대로 채우고, 최신 프레임이 오른쪽 끝에 오도록 그린다
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let frame = 0;
    const draw = () => {
      frame = requestAnimationFrame(draw);
      const context = canvas.getContext('2d');
      if (!context) return;
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const width = Math.max(1, Math.floor(rect.width));
      const height = Math.max(1, Math.floor(rect.height));
      if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
        canvas.width = width * dpr;
        canvas.height = height * dpr;
      }
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);
      context.fillStyle = getComputedStyle(canvas).getPropertyValue('--accent').trim() || '#3a6fe0';
      const count = Math.max(1, Math.floor((width + BAR_GAP) / (BAR_WIDTH + BAR_GAP)));
      const levels = levelsRef.current ?? [];
      for (let i = 0; i < count; i += 1) {
        const index = levels.length - count + i;
        const barHeight = index >= 0 ? levelToHeight(levels[index]) : MIN_HEIGHT;
        const x = i * (BAR_WIDTH + BAR_GAP);
        const y = (height - barHeight) / 2;
        context.beginPath();
        context.roundRect(x, y, BAR_WIDTH, barHeight, 1.5);
        context.fill();
      }
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [levelsRef]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || shouldIgnoreKey(event.target)) return;
      if (event.code === 'Space') {
        event.preventDefault();
        if (paused) onResume();
        else onPause();
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        onStop();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [paused, onPause, onResume, onStop]);

  return (
    <div className={styles.bar}>
      <button
        type="button"
        className={styles.stop}
        onClick={onStop}
        aria-label="녹음 중지 · 저장"
        data-tooltip="녹음 중지 · 저장"
        data-shortcut="Esc"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <rect x="6" y="6" width="12" height="12" rx="2" />
        </svg>
      </button>
      <span className={styles.time}>
        <span className={paused ? styles.dotPaused : styles.dot} />
        {formatTimestamp(elapsedMs)}
        {paused ? <span className={styles.pausedLabel}>일시정지</span> : null}
      </span>
      <canvas ref={canvasRef} className={styles.wave} aria-hidden="true" />
      <button
        type="button"
        className={styles.quiet}
        onClick={paused ? onResume : onPause}
        data-tooltip={paused ? '녹음 계속' : '일시정지'}
        data-shortcut="Space"
      >
        {paused ? '계속' : '일시정지'}
      </button>
      <button type="button" className={styles.save} onClick={onStop} data-tooltip="녹음을 마치고 노트로 저장">
        저장
      </button>
      <span className={styles.hint}>Space 일시정지 · Esc 중지</span>
    </div>
  );
};