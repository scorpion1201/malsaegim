'use client';

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { formatTimestamp } from '@/app/_lib/time';
import styles from './PlayerBar.module.css';

export type PlayerBarHandle = {
  /** 노트 전체 시간축의 ms 로 이동하고 재생한다 */
  seekTo: (ms: number) => void;
};

/** 재생할 오디오 한 파트 — 노트 시간축에서 offsetMs 부터 durationMs 동안 */
export type PlayerTrack = { blob: Blob; offsetMs: number; durationMs: number };

/** 파트 목록이 바뀌면 부모가 key 를 바꿔 새로 마운트한다 (처음 파트·0초부터) */
type PlayerBarProps = {
  /** 재생 소스 — 불러온 파일(File) 또는 IndexedDB 의 녹음 WAV(Blob). 이어 붙인 노트는 파트 여러 개를 하나처럼 이어 재생한다 */
  tracks: PlayerTrack[];
  durationMs: number | null;
  /** 노트 전체 시간축의 현재 위치 */
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

/** 노트 시간축의 ms 가 들어 있는 파트 */
const trackAt = (tracks: PlayerTrack[], ms: number): number => {
  for (let index = tracks.length - 1; index >= 0; index -= 1) if (ms >= tracks[index].offsetMs) return index;
  return 0;
};

export const PlayerBar = forwardRef<PlayerBarHandle, PlayerBarProps>(({ tracks, durationMs, onTimeUpdate }, ref) => {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [index, setIndex] = useState(0);
  const [url, setUrl] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);
  const [mediaDurationMs, setMediaDurationMs] = useState<number | null>(null);
  /** 파트를 바꾼 뒤 메타데이터가 오면 옮겨 갈 위치(파트 안 ms)와 재생 여부 */
  const pendingRef = useRef<{ localMs: number; play: boolean } | null>(null);
  const indexRef = useRef(0);
  const tracksRef = useRef(tracks);
  const onTimeUpdateRef = useRef(onTimeUpdate);
  useEffect(() => {
    tracksRef.current = tracks;
    onTimeUpdateRef.current = onTimeUpdate;
  });

  // object URL 은 effect 안에서 만들고 같은 effect 의 cleanup 에서 해제한다 (StrictMode 안전)
  const blob = tracks[index]?.blob ?? null;
  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return;
    }
    const objectUrl = URL.createObjectURL(blob);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [blob]);

  const single = tracks.length <= 1;
  const totalMs = single
    ? (mediaDurationMs ?? durationMs ?? 0)
    : (() => {
        const last = tracks[tracks.length - 1];
        return last.offsetMs + last.durationMs;
      })();

  /** 노트 시간축 ms 로 이동한다. 다른 파트면 그 파트를 띄운 뒤 메타데이터가 오면 옮긴다 */
  const seek = (ms: number, play: boolean) => {
    const list = tracksRef.current;
    if (list.length === 0) return;
    const clamped = Math.max(0, Math.min(ms, totalMs || ms));
    const target = trackAt(list, clamped);
    const localMs = clamped - list[target].offsetMs;
    setCurrentMs(clamped);
    const audio = audioRef.current;
    if (target === indexRef.current && audio) {
      audio.currentTime = localMs / 1000;
      if (play) void audio.play().catch(() => {});
      return;
    }
    pendingRef.current = { localMs, play: play || (audio ? !audio.paused : false) };
    indexRef.current = target;
    setIndex(target);
  };

  useImperativeHandle(ref, () => ({ seekTo: (ms) => seek(ms, true) }));

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
        const offset = tracksRef.current[indexRef.current]?.offsetMs ?? 0;
        const now = offset + audio.currentTime * 1000;
        seek(now + (event.key === 'ArrowLeft' ? -5000 : 5000), !audio.paused);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

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
          onEnded={() => {
            // 다음 파트가 있으면 이어서 재생한다
            const next = indexRef.current + 1;
            if (next < tracksRef.current.length) {
              pendingRef.current = { localMs: 0, play: true };
              indexRef.current = next;
              setIndex(next);
              return;
            }
            setPlaying(false);
          }}
          onLoadedMetadata={(event) => {
            const audio = event.currentTarget;
            const seconds = audio.duration;
            setMediaDurationMs(Number.isFinite(seconds) ? seconds * 1000 : null);
            const pending = pendingRef.current;
            pendingRef.current = null;
            if (!pending) return;
            audio.currentTime = pending.localMs / 1000;
            if (pending.play) void audio.play().catch(() => {});
          }}
          onTimeUpdate={(event) => {
            const offset = tracksRef.current[indexRef.current]?.offsetMs ?? 0;
            const ms = offset + event.currentTarget.currentTime * 1000;
            setCurrentMs(ms);
            onTimeUpdateRef.current(ms);
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
        {single ? null : ` · Part ${index + 1}/${tracks.length}`}
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
          onChange={(event) => seek(Number(event.target.value), false)}
        />
      </div>
      <span className={styles.hint}>{url ? 'Space 재생·정지 · ←/→ 5초 이동' : '오디오를 불러오거나 녹음하면 여기서 재생할 수 있습니다'}</span>
    </div>
  );
});

PlayerBar.displayName = 'PlayerBar';