'use client';

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { formatTimestamp } from '@/app/_lib/time';
import styles from './PlayerBar.module.css';

export type PlayerBarHandle = {
  seekTo: (ms: number) => void;
};

type PlayerBarProps = {
  /** 재생 소스 — 불러온 파일(File) 또는 IndexedDB 의 녹음 WAV(Blob) */
  source: Blob | null;
  durationMs: number | null;
  onTimeUpdate: (ms: number) => void;
};

/** 글을 입력 중이거나 버튼에 포커스가 있으면 플레이어 단축키를 가로채지 않는다 */
const shouldIgnoreKey = (target: EventTarget | null): boolean => {
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

export const PlayerBar = forwardRef<PlayerBarHandle, PlayerBarProps>(({ source, durationMs, onTimeUpdate }, ref) => {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);
  const [mediaDurationMs, setMediaDurationMs] = useState<number | null>(null);

  // object URL 은 effect 안에서 만들고 같은 effect 의 cleanup 에서 해제한다 (StrictMode 안전)
  useEffect(() => {
    if (!source) {
      setUrl(null);
      setPlaying(false);
      setCurrentMs(0);
      setMediaDurationMs(null);
      return;
    }
    const objectUrl = URL.createObjectURL(source);
    setUrl(objectUrl);
    setPlaying(false);
    setCurrentMs(0);
    return () => URL.revokeObjectURL(objectUrl);
  }, [source]);

  useImperativeHandle(ref, () => ({
    seekTo: (ms) => {
      const audio = audioRef.current;
      if (!audio) return;
      audio.currentTime = ms / 1000;
      void audio.play().catch(() => {});
    },
  }));

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const audio = audioRef.current;
      if (!audio || !url) return;
      if (event.ctrlKey || event.metaKey || event.altKey || shouldIgnoreKey(event.target)) return;
      if (event.code === 'Space') {
        event.preventDefault();
        if (audio.paused) void audio.play().catch(() => {});
        else audio.pause();
        return;
      }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        const delta = event.key === 'ArrowLeft' ? -5 : 5;
        audio.currentTime = Math.max(0, Math.min(audio.duration || 0, audio.currentTime + delta));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [url]);

  const totalMs = mediaDurationMs ?? durationMs ?? 0;
  const ratio = totalMs > 0 ? Math.min(1, currentMs / totalMs) : 0;

  const toggle = () => {
    const audio = audioRef.current;
    if (!audio || !url) return;
    if (audio.paused) void audio.play().catch(() => {});
    else audio.pause();
  };

  return (
    <div className={styles.bar}>
      {url ? (
        <audio
          ref={audioRef}
          src={url}
          preload="metadata"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onLoadedMetadata={(event) => {
            const seconds = event.currentTarget.duration;
            setMediaDurationMs(Number.isFinite(seconds) ? seconds * 1000 : null);
          }}
          onTimeUpdate={(event) => {
            const ms = event.currentTarget.currentTime * 1000;
            setCurrentMs(ms);
            onTimeUpdate(ms);
          }}
        />
      ) : null}
      <button
        type="button"
        className={styles.play}
        onClick={toggle}
        disabled={!url}
        aria-label={playing ? '일시정지' : '재생'}
        data-tooltip={playing ? '일시정지' : '재생'}
        data-shortcut="Space"
      >
        {playing ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M7 5h4v14H7zM13 5h4v14h-4z" />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M8 5v14l11-7z" />
          </svg>
        )}
      </button>
      <span className={styles.time}>
        {formatTimestamp(currentMs)} / {formatTimestamp(totalMs)}
      </span>
      <div className={styles.track}>
        <div className={styles.fill} style={{ width: `${ratio * 100}%` }} />
        <div className={styles.knob} style={{ left: `${ratio * 100}%` }} />
        <input
          type="range"
          className={styles.range}
          min={0}
          max={Math.max(1, Math.floor(totalMs))}
          value={Math.floor(currentMs)}
          disabled={!url}
          aria-label="재생 위치"
          onChange={(event) => {
            const audio = audioRef.current;
            const ms = Number(event.target.value);
            setCurrentMs(ms);
            if (audio) audio.currentTime = ms / 1000;
          }}
        />
      </div>
      <span className={styles.hint}>{url ? 'Space 재생·정지 · ←/→ 5초 이동' : '오디오를 불러오거나 녹음하면 여기서 재생할 수 있습니다'}</span>
    </div>
  );
});

PlayerBar.displayName = 'PlayerBar';