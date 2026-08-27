'use client';

import { formatMb } from '@/app/_lib/engine/malsaegimEngine';
import { useDialog } from '../Dialog/DialogProvider';
import { CheckIcon, ChipIcon, CrossIcon, DownloadIcon } from '../OnDevice/icons';
import { useModelDownload, type ModelStatus } from '../OnDevice/ModelProvider';
import styles from './Settings.module.css';

const SUBTITLE: Record<Exclude<ModelStatus, 'unavailable'>, string> = {
  unknown: '확인하는 중입니다.',
  missing: '아직 내려받지 않았습니다.',
  downloading: '브라우저에 내려받는 중입니다.',
  ready: '브라우저에 보관됨',
  error: '내려받기가 끊겨 이어서 받을 수 있습니다.',
};

/** 설정 페이지 맨 위 카드 — 모델 두 개를 "한국어 On-Device 모델" 한 줄로 보여 준다 */
export const OnDeviceModelCard = () => {
  const model = useModelDownload();
  const dialog = useDialog();
  const total = formatMb(model.totalBytes);
  const subtitle = model.status === 'unavailable' ? (model.message ?? '서버에 모델이 없습니다') : SUBTITLE[model.status];

  const remove = async () => {
    const ok = await dialog.confirm({
      kind: 'danger',
      title: 'On-Device 모델을 삭제할까요?',
      description: `이 브라우저에 보관된 모델(약 ${total} MB)을 지웁니다. 다시 쓰려면 다시 내려받아야 합니다.`,
      confirmLabel: '삭제',
    });
    if (ok) await model.remove();
  };

  return (
    <section className={styles.card}>
      <div className={styles.cardText}>
        <span className={styles.cardTitle}>
          <span className={styles.cardIcon}>
            <ChipIcon />
          </span>
          On-Device 모델
        </span>
        <span className={styles.cardDescription}>음성 인식이 이 브라우저(On-Device) 안에서만 실행됩니다.</span>
      </div>

      <div className={styles.modelRow}>
        <span className={styles.modelIcon}>
          <ChipIcon />
        </span>
        <div className={styles.modelText}>
          <span className={styles.modelName}>한국어 On-Device 모델</span>
          <span className={styles.modelSub}>{subtitle}</span>
        </div>
        <div className={styles.modelStatus}>
          {model.status === 'missing' ? (
            <>
              <span className={styles.modelMeta}>약 {total} MB</span>
              <button type="button" className={styles.smallButton} onClick={model.start}>
                <DownloadIcon />
                내려받기
              </button>
            </>
          ) : null}
          {model.status === 'downloading' ? (
            <div className={styles.modelProgress}>
              <div className={styles.modelProgressHead}>
                <span>내려받는 중</span>
                <span className={styles.tabular}>
                  {model.percent}% · {formatMb(model.receivedBytes)} / {total} MB
                </span>
              </div>
              <div className={styles.modelBar}>
                <div className={styles.modelBarFill} style={{ width: `${model.percent}%` }} />
              </div>
            </div>
          ) : null}
          {model.status === 'ready' ? (
            <>
              <span className={styles.modelOk}>
                <CheckIcon />
                준비됨 · 약 {total} MB
              </span>
              <button type="button" className={styles.quietButton} onClick={() => void remove()} data-tooltip="이 브라우저에서 모델 삭제">
                삭제
              </button>
            </>
          ) : null}
          {model.status === 'error' ? (
            <>
              <span className={styles.modelFail}>
                <CrossIcon />
                실패
                <span className={styles.modelFailDetail}>· {model.message ?? '네트워크 오류'}</span>
              </span>
              <button type="button" className={styles.smallButton} onClick={model.retry}>
                다시 시도
              </button>
            </>
          ) : null}
        </div>
      </div>
    </section>
  );
};