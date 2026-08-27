'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { formatEta, formatMb } from '@/app/_lib/engine/malsaegimEngine';
import { CheckIcon, CrossIcon, SpinnerIcon } from './icons';
import { useModelDownload } from './ModelProvider';
import styles from './OnDevice.module.css';

/** 백그라운드 내려받기 카드 — 우하단 플레이어 바 위. 보이는 동안 토스트 기둥을 위로 밀어 올린다. 누르면 설정 */
export const ModelDownloadCard = () => {
  const model = useModelDownload();
  const router = useRouter();
  const failed = model.status === 'error';
  const ready = model.status === 'ready' && model.justReady;
  const visible = model.status === 'downloading' || failed || ready;

  useEffect(() => {
    if (!visible) return;
    document.documentElement.dataset.modelCard = '1';
    return () => {
      delete document.documentElement.dataset.modelCard;
    };
  }, [visible]);

  if (!visible) return null;
  const total = formatMb(model.totalBytes);
  const received = formatMb(model.receivedBytes);

  return (
    <div role="status" className={styles.card} title="설정에서 보기" onClick={() => router.push('/settings')}>
      <span className={ready ? styles.cardIconDone : failed ? styles.cardIconFailed : styles.cardIcon}>
        {ready ? <CheckIcon size={16} /> : failed ? <CrossIcon size={16} /> : <SpinnerIcon className={styles.spin} />}
      </span>
      <div className={styles.cardBody}>
        <span className={styles.cardTitle}>
          {ready ? 'On-Device 모델 준비 완료' : failed ? '내려받기가 끊겼습니다' : 'On-Device 모델 내려받는 중'}
        </span>
        {ready ? (
          <div className={styles.cardBarDone} />
        ) : (
          <div className={styles.cardBar}>
            <div className={failed ? styles.cardFillFailed : styles.cardFill} style={{ width: `${model.percent}%` }} />
          </div>
        )}
        <div className={styles.cardFoot}>
          {ready ? (
            <span>이제 API 키 없이 인식할 수 있습니다</span>
          ) : failed ? (
            <>
              <span>
                {received} / {total} MB 까지 받았습니다
              </span>
              <button
                type="button"
                className={styles.cardRetry}
                onClick={(event) => {
                  event.stopPropagation();
                  model.retry();
                }}
              >
                다시 시도
              </button>
            </>
          ) : (
            <>
              <span>
                {received} / {total} MB · {formatEta(model.etaSec)}
              </span>
              <span className={styles.tabular}>{model.percent}%</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
};