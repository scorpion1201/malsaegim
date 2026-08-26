'use client';

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { formatTimestamp } from '@/app/_lib/time';
import styles from './AudioPlayer.module.css';

export type AudioPlayerHandle = {
  seekTo: (ms: number) => void;
};

type AudioPlayerProps = {
  file: File | null;
  currentMs: number;
  durationMs: number | null;
  onTimeUpdate: (ms: number) => void;
};

export const AudioPlayer = forwardRef<AudioPlayerHandle, AudioPlayerProps>(
      ({ file, currentMs, durationMs, onTimeUpdate }, ref) => {
        const audioRef = useRef<HTMLAudioElement>(null);
        const url = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);

        useEffect(() => () => {
          if (url) URL.revokeObjectURL(url);
            }, [url]);

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
            if (!audio || !(event.ctrlKey || event.metaKey)) return;
            if (event.code === 'Space') {
              event.preventDefault();
              if (audio.paused) void audio.play().catch(() => {});
              else audio.pause();
              } else if (event.key === 'ArrowLeft') {
              event.preventDefault();
              audio.currentTime = Math.max(0, audio.currentTime - 5);
              } else if (event.key === 'ArrowRight') {
              event.preventDefault();
              audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 5);
              }
             };
          window.addEventListener('keydown', onKey);
          return () => window.removeEventListener('keydown', onKey);
            }, []);

        if (!url) {
          return <div className={styles.empty}>mp3를 선택하면 여기서 재생할 수 있습니다.</div>;
          }

        return (
             <div className={styles.player}>
               <audio
               ref={audioRef}
               src={url}
               controls
               preload="metadata"
               className={styles.audio}
               onTimeUpdate={(event) => onTimeUpdate(event.currentTarget.currentTime * 1000)}
               />
               <span className={styles.time}>
                {formatTimestamp(currentMs)}
                {durationMs !== null ? ` / ${formatTimestamp(durationMs)}` : ''}
               </span>
               <span className={styles.hint}>Ctrl/⌘+Space 재생·정지, Ctrl/⌘+←/→ 5초 이동</span>
             </div>
           );
      },
);

AudioPlayer.displayName = 'AudioPlayer';