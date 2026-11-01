'use client';

import styles from './Translation.module.css';

export type TranslationNoticeProps = {
  kind: 'key' | 'unsupported';
  onOpenSettings: () => void;
  onGoTranscribe: () => void;
};

export const supportsTranslation = (): boolean =>
  typeof RTCPeerConnection !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia);

const KeyIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="8" cy="15" r="4" />
    <path d="M10.8 12.2 20 3M15 8l3 3M18 5l3 3" />
  </svg>
);

const InfoIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
    <path d="M12 11v5M12 7.5v.5" />
  </svg>
);

export const TranslationNotice = ({ kind, onOpenSettings, onGoTranscribe }: TranslationNoticeProps) => (
  <div className={styles.noticeWrap}>
    <section className={styles.noticeCard}>
      <span className={styles.panelTitle}>
        <span className={styles.panelIcon}>{kind === 'key' ? <KeyIcon /> : <InfoIcon />}</span>
        {kind === 'key' ? 'OpenAI API 키가 필요합니다' : '이 브라우저에서는 실시간 번역을 쓸 수 없습니다'}
      </span>
      <span className={styles.noticeText}>
        {kind === 'key'
          ? '실시간 번역은 OpenAI 서비스를 사용합니다. On-Device 모델은 번역에 쓰이지 않습니다. 받아쓰기는 키 없이 그대로 쓸 수 있습니다. 키를 넣으면 상대 언어와 내 언어를 고르고 시작할 수 있습니다.'
          : 'Chrome이나 Edge 데스크톱 버전에서 열어 주세요. 받아쓰기와 저장된 번역 노트는 이 브라우저에서도 쓸 수 있습니다.'}
      </span>
      <div className={styles.noticeActions}>
        <button type="button" className={styles.secondary} onClick={onGoTranscribe}>
          받아쓰기로 가기
        </button>
        {kind === 'key' ? (
          <button type="button" className={styles.primary} onClick={onOpenSettings}>
            설정에서 키 넣기
          </button>
        ) : null}
      </div>
    </section>
  </div>
);