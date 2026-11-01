'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { TranscriptBlock } from '@/app/_lib/asr/assembleTranscript';
import { AUTO_SOURCE, languageLabel, pairLabel } from '@/app/_lib/translation/languages';
import type { TranslationStatus } from '@/app/_lib/translation/translationRecognizer';
import { formatTimestamp } from '@/app/_lib/time';
import styles from './Translation.module.css';

export type TranslationView = 'both' | 'target' | 'source';

export type TranslationLiveViewProps = {
  blocks: TranscriptBlock[];
  partial: { source: string; translation: string };
  nextStartMs: number;
  status: TranslationStatus;
  delayed: boolean;
  sourceLanguage: string;
  targetLanguage: string;
  banner: ReactNode;
};

const VIEWS: { value: TranslationView; label: string }[] = [
  { value: 'both', label: '나란히' },
  { value: 'target', label: '번역만' },
  { value: 'source', label: '원문만' },
];

/** 바닥에서 이만큼 안쪽이면 새 행을 따라간다 */
const FOLLOW_SLACK_PX = 48;

const statusLabel = (status: TranslationStatus, delayed: boolean): { label: string; dot: string } => {
  switch (status) {
    case 'connecting':
      return { label: '연결 중', dot: styles.statusAccent };
    case 'paused':
    case 'parked':
      return { label: '일시정지', dot: styles.statusMuted };
    case 'reconnecting':
      return { label: '번역 다시 연결 중', dot: styles.statusWarn };
    case 'unavailable':
      return { label: '번역 중단', dot: styles.statusDanger };
    case 'draining':
      return { label: '마무리 중', dot: styles.statusAccent };
    default:
      return delayed ? { label: '처리 지연', dot: styles.statusWarn } : { label: '듣는 중', dot: styles.statusSuccess };
  }
};

const LockIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="5" y="11" width="14" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </svg>
);

export const TranslationLiveView = ({
  blocks,
  partial,
  nextStartMs,
  status,
  delayed,
  sourceLanguage,
  targetLanguage,
  banner,
}: TranslationLiveViewProps) => {
  const [view, setView] = useState<TranslationView>('both');
  const [following, setFollowing] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  const auto = sourceLanguage === AUTO_SOURCE;
  const sourceLang = auto ? undefined : sourceLanguage;
  const { label, dot } = statusLabel(status, delayed);
  const showSource = view !== 'target';
  const showTarget = view !== 'source';
  const connecting = status === 'connecting';
  const hasPartial = partial.source.length > 0 || partial.translation.length > 0;

  useEffect(() => {
    const scroller = scrollRef.current;
    if (following && scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [following, blocks, partial]);

  const onScroll = () => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    setFollowing(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < FOLLOW_SLACK_PX);
  };

  return (
    <div className={`${styles.live} ${view === 'both' ? styles.viewBoth : view === 'target' ? styles.viewTarget : styles.viewSource}`}>
      <div className={styles.liveToolbar}>
        <div className={styles.liveToolbarLeft}>
          <div className={styles.viewSegments} role="group" aria-label="보기">
            {VIEWS.map((item) => (
              <button
                key={item.value}
                type="button"
                className={view === item.value ? styles.viewActive : styles.viewButton}
                aria-pressed={view === item.value}
                onClick={(event) => {
                  event.currentTarget.blur();
                  setView(item.value);
                }}
              >
                {item.label}
              </button>
            ))}
          </div>
          <span className={styles.languageChip} data-tooltip="번역 중에는 언어를 바꿀 수 없습니다">
            <span>{pairLabel(sourceLanguage, targetLanguage)}</span>
            <LockIcon />
          </span>
        </div>
        <span role="status" className={styles.statusLabel}>
          <span className={dot} />
          {label}
        </span>
      </div>
      <div className={styles.liveRule} />
      {banner}
      <div className={styles.columnHead}>
        <div className={styles.liveRow}>
          <span />
          {showSource ? <span>{auto ? '원문' : `${languageLabel(sourceLanguage)} 원문`}</span> : null}
          {showTarget ? <span>{`${languageLabel(targetLanguage)} 번역`}</span> : null}
        </div>
      </div>
      <div className={styles.liveBody}>
        {view === 'both' ? <div className={styles.columnLine} /> : null}
        <div ref={scrollRef} className={styles.liveScroll} onScroll={onScroll}>
          <div className={styles.liveColumns}>
            <div role="log" aria-label="확정된 번역" className={styles.liveLog}>
              {blocks.map((block) => (
                <div key={block.startMs} className={styles.liveRow}>
                  <span className={styles.chip}>{formatTimestamp(block.startMs)}</span>
                  {showSource ? (
                    <span lang={sourceLang} className={styles.sourceCell}>
                      {block.text}
                    </span>
                  ) : null}
                  {showTarget ? (
                    <span lang={targetLanguage} className={styles.targetCell}>
                      {block.translation}
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
            {connecting ? (
              <div className={styles.liveRow}>
                <span className={styles.chipLive}>00:00</span>
                <span className={styles.connecting}>
                  <span className={styles.spinner} />
                  번역을 연결하는 중입니다
                </span>
              </div>
            ) : hasPartial || delayed ? (
              <div className={styles.liveRow}>
                <span className={styles.chipLive}>{formatTimestamp(nextStartMs)}</span>
                {showSource ? (
                  <span lang={sourceLang} className={styles.sourceCell}>
                    {partial.source}
                    <span className={styles.caret} />
                  </span>
                ) : null}
                {showTarget ? (
                  delayed && !partial.translation ? (
                    <span className={styles.waitingCell}>번역을 기다리는 중입니다</span>
                  ) : (
                    <span lang={targetLanguage} className={styles.targetCell}>
                      {partial.translation}
                      <span className={styles.caret} />
                    </span>
                  )
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
        {following ? null : (
          <button
            type="button"
            className={styles.latestButton}
            onClick={(event) => {
              event.currentTarget.blur();
              setFollowing(true);
            }}
          >
            최신으로
          </button>
        )}
      </div>
    </div>
  );
};