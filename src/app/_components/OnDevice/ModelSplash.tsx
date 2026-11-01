'use client';

import Image from 'next/image';
import { formatEta, formatMb } from '@/app/_lib/engine/malsaegimEngine';
import { CheckIcon } from './icons';
import { useModelDownload } from './ModelProvider';
import styles from './OnDevice.module.css';

type ModelSplashProps = {
  /** "백그라운드에서 계속" — 에디터로 나가고 우하단 카드가 남는다 */
  onBackground: () => void;
  /** 완료 화면의 "시작하기" */
  onEnter: () => void;
};

/** 첫 방문(API 미설정 · 모델 없음) 스플래시 — 엔진 런타임과 이 기기에 맞춘 모델 하나를 진행률 하나로 보여 준다 */
export const ModelSplash = ({ onBackground, onEnter }: ModelSplashProps) => {
  const model = useModelDownload();
  const total = formatMb(model.totalBytes);
  const received = formatMb(model.receivedBytes);
  const ready = model.status === 'ready';
  const failed = model.status === 'error';
  const modelName = model.selected ? `${model.selected.label} (${model.selected.quant.toUpperCase()})` : '한국어 On-Device 모델';

  return (
    <div className={styles.splash}>
      <div className={styles.splashBrand}>
        <Image src="/app-logo.png" alt="" width={96} height={96} priority draggable={false} className={styles.splashLogo} />
        <span className={styles.splashTitle}>말새김</span>
        <span className={styles.splashHeadline}>
          {ready ? '준비가 끝났습니다' : failed ? '내려받기가 끊겼습니다' : '음성 인식 모델을 내려받는 중'}
        </span>
      </div>

      <div className={styles.splashProgress}>
        {ready ? (
          <div className={styles.splashBarDone} />
        ) : (
          <div className={styles.splashBar}>
            <div className={failed ? styles.splashFillFailed : styles.splashFill} style={{ width: `${model.percent}%` }} />
          </div>
        )}
        <div className={styles.splashMeta}>
          {ready ? (
            <span className={styles.splashOk}>
              <CheckIcon />
              {modelName} · 약 {total} MB
            </span>
          ) : failed ? (
            <span className={styles.splashFailed}>
              {model.message ?? '네트워크 오류'} · {received} / {total} MB 까지 받았습니다
            </span>
          ) : (
            <span>
              {modelName} · {received} / {total} MB · {formatEta(model.etaSec)}
            </span>
          )}
          <span className={styles.tabular}>{ready ? '' : `${model.percent}%`}</span>
        </div>
      </div>

      {ready ? (
        <button type="button" className={styles.splashButton} onClick={onEnter}>
          시작하기
        </button>
      ) : null}
      {failed ? (
        <button type="button" className={styles.splashButton} onClick={model.retry}>
          이어서 받기
        </button>
      ) : null}

      <span className={styles.splashNote}>
        {ready ? (
          '모델은 이 브라우저에만 보관되고, 음성 인식은 기기 안(On-Device)에서만 실행됩니다.'
        ) : failed ? (
          '받은 부분은 남아 있어 처음부터 다시 받지 않습니다'
        ) : (
          <>
            On-Device 에서 사용하기 위해 모델을 내려받는 중입니다.
            <br />
            브라우저에서만 보관됩니다.
          </>
        )}
      </span>

      {ready ? null : (
        <button type="button" className={styles.splashLink} onClick={onBackground}>
          백그라운드에서 계속
        </button>
      )}
    </div>
  );
};