'use client';

import { useSyncExternalStore } from 'react';
import { formatMb, readGpuPreference, subscribeGpuPreference, writeGpuPreference, type DeviceKind, type WhisperModel } from '@/app/_lib/engine/malsaegimEngine';
import { useDialog } from '../Dialog/DialogProvider';
import { CheckIcon, ChipIcon, CrossIcon, DownloadIcon } from '../OnDevice/icons';
import { useModelDownload, type ModelStatus } from '../OnDevice/ModelProvider';
import styles from './Settings.module.css';

const SUBTITLE: Record<Exclude<ModelStatus, 'unavailable'>, string> = {
  unknown: '확인하는 중입니다.',
  missing: '아직 내려받지 않았습니다.',
  downloading: '브라우저에 내려받는 중입니다.',
  ready: '브라우저에 보관됨 · 실시간·파일 전사 공용',
  error: '내려받기가 끊겨 이어서 받을 수 있습니다.',
};

const DEVICE_LABEL: Record<DeviceKind, string> = { desktop: 'PC', ipad: 'iPad', mobile: '모바일' };

const describeModel = (model: WhisperModel): string =>
  `${model.quant.toUpperCase()} · 약 ${formatMb(model.file.bytes)} MB · 실행 메모리 약 ${(model.memoryMB / 1024).toFixed(1)} GB${
    model.tier === 'full' ? ' · 한국어 정확도 우선' : ' · 메모리가 적은 기기용'
  }`;

/** 설정 페이지 맨 위 카드 — 이 기기에 받을 모델 하나와 그 상태. 실시간 받아쓰기와 파일 전사가 같은 모델을 쓴다 */
export const OnDeviceModelCard = () => {
  const model = useModelDownload();
  const dialog = useDialog();
  const total = formatMb(model.totalBytes);
  const subtitle = model.status === 'unavailable' ? (model.message ?? '서버에 모델이 없습니다') : SUBTITLE[model.status];
  const name = model.selected ? `${model.selected.label} (${model.selected.quant.toUpperCase()})` : '한국어 On-Device 모델';
  const deviceLabel = model.device ? DEVICE_LABEL[model.device.kind] : null;
  const gpu = useSyncExternalStore(subscribeGpuPreference, readGpuPreference, () => true);

  const remove = async () => {
    const ok = await dialog.confirm({
      kind: 'danger',
      title: 'On-Device 모델을 삭제할까요?',
      description: `이 브라우저에 보관된 모델(약 ${total} MB)을 지웁니다. 다시 쓰려면 다시 내려받아야 합니다.`,
      confirmLabel: '삭제',
    });
    if (ok) await model.remove();
  };

  const choose = async (choice: string) => {
    if (choice === model.choice) return;
    const current = model.status === 'ready' && model.selected ? model.selected : null;
    if (current) {
      const ok = await dialog.confirm({
        title: '모델을 바꿀까요?',
        description: `새 모델을 내려받아야 합니다. 새 모델을 다 받으면 지금 모델(${current.label}, 약 ${formatMb(current.file.bytes)} MB)은 삭제됩니다.`,
        confirmLabel: '바꾸기',
      });
      if (!ok) return;
    }
    await model.choose(choice);
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
        <span className={styles.cardDescription}>
          음성 인식이 이 브라우저(On-Device) 안에서만 실행됩니다. 기기 안에서 인식하지 못해도 음성을 서버로 보내지 않습니다.
        </span>
      </div>

      <div className={styles.modelRow}>
        <span className={styles.modelIcon}>
          <ChipIcon />
        </span>
        <div className={styles.modelText}>
          <span className={styles.modelName}>{name}</span>
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

      {model.models.length > 1 ? (
        <fieldset className={styles.modelChoices} disabled={model.status === 'unknown'}>
          <legend className={styles.modelChoicesLabel}>사용할 모델</legend>
          <label className={styles.modelChoice}>
            <input type="radio" name="ondevice-model" checked={model.choice === 'auto'} onChange={() => void choose('auto')} />
            <span className={styles.modelChoiceText}>
              <span className={styles.modelChoiceName}>
                자동{model.autoSelected ? ` — ${model.autoSelected.label}` : ''}
              </span>
              <span className={styles.modelChoiceSub}>
                {deviceLabel ? `이 기기(${deviceLabel})에 맞춰 고릅니다. ` : ''}PC·iPad 는 Turbo, 메모리가 적은 모바일은 small
              </span>
            </span>
          </label>
          {model.models.map((entry) => (
            <label key={entry.id} className={styles.modelChoice}>
              <input type="radio" name="ondevice-model" checked={model.choice === entry.id} onChange={() => void choose(entry.id)} />
              <span className={styles.modelChoiceText}>
                <span className={styles.modelChoiceName}>{entry.label}</span>
                <span className={styles.modelChoiceSub}>{describeModel(entry)}</span>
              </span>
            </label>
          ))}
        </fieldset>
      ) : null}

      <label className={styles.modelChoice}>
        <input
          type="checkbox"
          checked={gpu}
          onChange={(event) => writeGpuPreference(event.target.checked)}
        />
        <span className={styles.modelChoiceText}>
          <span className={styles.modelChoiceName}>WebGPU 가속 (실험적)</span>
          <span className={styles.modelChoiceSub}>
            브라우저가 WebGPU(shader-f16)를 지원하면 GPU 로 인식합니다. 쓸 수 없거나 실패하면 자동으로 CPU 로 돌아갑니다.
          </span>
        </span>
      </label>
    </section>
  );
};