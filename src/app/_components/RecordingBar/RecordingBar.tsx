'use client';

import { useEffect, useRef, type RefObject } from 'react';
import { formatTimestamp } from '@/app/_lib/time';
import type { SpeakerView } from '@/app/_lib/translation/speaker';
import styles from './RecordingBar.module.css';

export type RecordingBarProps = {
  elapsedMs: number;
  paused: boolean;
  /** 100ms 프레임별 RMS — 훅이 채우고 여기서는 rAF 로 읽기만 한다 (상태로 두면 초당 10번 리렌더) */
  levelsRef: RefObject<number[]>;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  /** 번역 세션만 준다 */
  speaker?: { view: SpeakerView; onToggle: () => void };
};

const SPEAKER_TEXT: Record<SpeakerView, { label: string; tooltip: string; announce: string }> = {
  on: { label: '번역 음성', tooltip: '번역 음성 끄기', announce: '번역 음성을 켰습니다' },
  off: { label: '음성 꺼짐', tooltip: '번역 음성 켜기', announce: '번역 음성을 껐습니다' },
  blocked: { label: '소리 켜기', tooltip: '소리 켜기', announce: '브라우저가 소리를 막았습니다' },
  fuse: { label: '에코로 꺼짐', tooltip: '번역 음성 켜기', announce: '에코가 감지되어 번역 음성을 껐습니다' },
};

const SPEAKER_CLASS: Record<SpeakerView, string> = {
  on: styles.speakerOn,
  off: styles.speakerOff,
  blocked: styles.speakerBlocked,
  fuse: styles.speakerOff,
};

const SpeakerIcon = ({ crossed }: { crossed: boolean }) => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 9v6h4l5 4V5L8 9H4z" />
    {crossed ? <path d="M3 3l18 18" /> : <path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11" />}
  </svg>
);

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

export const RecordingBar = ({ elapsedMs, paused, levelsRef, onPause, onResume, onStop, speaker }: RecordingBarProps) => {
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
      if (speaker && event.code === 'KeyM') {
        event.preventDefault();
        speaker.onToggle();
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        onStop();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [paused, onPause, onResume, onStop, speaker]);

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
      {speaker ? (
        <>
          <button
            type="button"
            className={`${styles.speaker} ${SPEAKER_CLASS[speaker.view]}`}
            aria-label="번역 음성"
            aria-pressed={speaker.view === 'on'}
            data-tooltip={SPEAKER_TEXT[speaker.view].tooltip}
            data-shortcut="M"
            onClick={(event) => {
              // 포커스를 남기면 M 과 Space 가 버튼에 먹힌다
              event.currentTarget.blur();
              speaker.onToggle();
            }}
          >
            <SpeakerIcon crossed={speaker.view === 'off' || speaker.view === 'fuse'} />
            <span>{SPEAKER_TEXT[speaker.view].label}</span>
          </button>
          <span role="status" className={styles.srOnly}>
            {SPEAKER_TEXT[speaker.view].announce}
          </span>
        </>
      ) : null}
      <button
        type="button"
        className={styles.quiet}
        onClick={(event) => {
          event.currentTarget.blur();
          if (paused) onResume();
          else onPause();
        }}
        data-tooltip={paused ? '녹음 계속' : '일시정지'}
        data-shortcut="Space"
      >
        {paused ? '계속' : '일시정지'}
      </button>
      <button type="button" className={styles.save} onClick={onStop} data-tooltip="녹음을 마치고 노트로 저장">
        저장
      </button>
      <span className={styles.hint}>{speaker ? 'Space 일시정지 · M 음성 · Esc 중지' : 'Space 일시정지 · Esc 중지'}</span>
    </div>
  );
};