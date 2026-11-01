'use client';

import { useEffect, useState } from 'react';
import type { TranslationStatus } from '@/app/_lib/translation/translationRecognizer';
import { formatTimestamp } from '@/app/_lib/time';
import styles from './Translation.module.css';

export type TranslationBannerProps = {
  status: TranslationStatus;
  /** 일시정지를 누른 시각 (Date.now) */
  pausedAtMs: number | null;
  speakerBlocked: boolean;
  speakerOn: boolean;
  micLost: boolean;
  onReconnect: () => void;
  onDismissUnavailable: () => void;
};

const PARK_AFTER_MS = 60_000;

const WarnIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3 2 20h20L12 3zM12 10v5M12 17.5v.5" />
  </svg>
);

const SpeakerIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 9v6h4l5 4V5L8 9H4z" />
    <path d="M16 9a4 4 0 0 1 0 6" />
  </svg>
);

/** 일시정지 후 세션이 닫힐 때까지 남은 시간 */
const useCountdown = (pausedAtMs: number | null): number => {
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (pausedAtMs === null) return;
    const update = () => setNow(Date.now());
    const first = setTimeout(update, 0);
    const timer = setInterval(update, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [pausedAtMs]);
  if (pausedAtMs === null || now === 0) return PARK_AFTER_MS;
  return Math.max(0, PARK_AFTER_MS - (now - pausedAtMs));
};

export const TranslationBanner = ({ status, pausedAtMs, speakerBlocked, speakerOn, micLost, onReconnect, onDismissUnavailable }: TranslationBannerProps) => {
  const remainingMs = useCountdown(status === 'paused' ? pausedAtMs : null);

  if (status === 'paused' || status === 'parked') {
    const parked = status === 'parked' || remainingMs === 0;
    return (
      <div role="status" className={styles.banner}>
        <span className={styles.bannerDot} />
        <span className={styles.bannerText}>
          <span className={styles.bannerTitle}>일시정지</span>
          <span className={styles.bannerDetail}>
            {parked ? '번역 연결을 닫았습니다. 계속을 누르면 다시 연결합니다' : `${formatTimestamp(remainingMs)} 안에 계속하면 바로 이어집니다`}
          </span>
        </span>
      </div>
    );
  }
  if (status === 'reconnecting') {
    return (
      <div role="status" className={styles.bannerWarn}>
        <span className={styles.spinner} />
        <span className={styles.bannerText}>
          <span className={styles.bannerTitle}>번역을 다시 연결하는 중입니다</span>
          <span className={styles.bannerDetail}>녹음은 계속 저장됩니다.{speakerOn ? ' 연결되면 다시 들립니다.' : ''}</span>
        </span>
      </div>
    );
  }
  if (status === 'unavailable' && micLost) {
    return (
      <div role="status" className={styles.bannerDanger}>
        <span className={styles.bannerIconDanger}>
          <WarnIcon />
        </span>
        <span className={styles.bannerText}>
          <span className={styles.bannerTitleDanger}>마이크 연결이 끊겼습니다</span>
          <span className={styles.bannerDetail}>녹음도 멈췄을 수 있습니다. 저장한 뒤 다시 시작하세요</span>
        </span>
      </div>
    );
  }
  if (status === 'unavailable') {
    return (
      <div role="status" className={styles.bannerDanger}>
        <span className={styles.bannerIconDanger}>
          <WarnIcon />
        </span>
        <span className={styles.bannerText}>
          <span className={styles.bannerTitleDanger}>번역이 멈췄습니다</span>
          <span className={styles.bannerDetail}>녹음은 계속 저장됩니다</span>
        </span>
        <button type="button" className={styles.bannerPrimary} onClick={onReconnect}>
          다시 연결
        </button>
        <button type="button" className={styles.bannerSecondary} onClick={onDismissUnavailable}>
          번역 없이 녹음 계속
        </button>
      </div>
    );
  }
  if (status === 'draining') {
    return (
      <div role="status" className={styles.banner}>
        <span className={styles.spinner} />
        <span className={styles.bannerText}>
          <span className={styles.bannerTitle}>마지막 번역을 받는 중입니다</span>
          <span className={styles.bannerDetail}>끝나면 노트로 저장합니다</span>
        </span>
      </div>
    );
  }
  if (speakerBlocked) {
    return (
      <div role="status" className={styles.bannerWarn}>
        <span className={styles.bannerIconWarn}>
          <SpeakerIcon />
        </span>
        <span className={styles.bannerText}>
          <span className={styles.bannerTitle}>브라우저가 소리를 막았습니다</span>
          <span className={styles.bannerDetail}>녹음 바의 소리 켜기를 누르세요</span>
        </span>
      </div>
    );
  }
  return null;
};