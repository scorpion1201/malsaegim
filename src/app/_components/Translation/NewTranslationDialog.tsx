'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { AUTO_SOURCE, SOURCE_LANGUAGES, TARGET_LANGUAGES, languageLabel } from '@/app/_lib/translation/languages';
import styles from './Translation.module.css';

export type TranslationChoice = { sourceLanguage: string; targetLanguage: string; speakerOn: boolean };

export type NewTranslationDialogProps = {
  initial: TranslationChoice;
  initialFocus: 'source' | 'start';
  micLabel: string;
  onClose: (choice: TranslationChoice) => void;
  onStart: (choice: TranslationChoice) => void;
};

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const;

const TranslateIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" {...stroke} strokeWidth="1.8">
    <path d="M4 5h9M8.5 3v2M11 5c-.8 3.6-3 6.6-7 8.5M5.5 8.5c1.2 2 3 3.7 5.5 5" />
    <path d="M12 21l4.5-10L21 21M13.6 18h5.8" />
  </svg>
);

const CloseIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" {...stroke} strokeWidth="2">
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

const SwapIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" {...stroke} strokeWidth="2">
    <path d="M7 4L3 8l4 4M3 8h14M17 12l4 4-4 4M21 16H7" />
  </svg>
);

const MicIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" {...stroke} strokeWidth="1.8">
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8" />
  </svg>
);

const ChevronIcon = () => (
  <svg className={styles.selectChevron} width="14" height="14" viewBox="0 0 24 24" {...stroke} strokeWidth="2">
    <path d="M6 9l6 6 6-6" />
  </svg>
);

export const NewTranslationDialog = ({ initial, initialFocus, micLabel, onClose, onStart }: NewTranslationDialogProps) => {
  const [choice, setChoice] = useState(initial);
  const panelRef = useRef<HTMLDivElement>(null);
  const sourceRef = useRef<HTMLSelectElement>(null);
  const startRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  const { sourceLanguage, targetLanguage, speakerOn } = choice;
  const auto = sourceLanguage === AUTO_SOURCE;
  const same = sourceLanguage === targetLanguage;
  const target = languageLabel(targetLanguage);
  const pairLine = same
    ? '두 언어가 같습니다. 상대 언어나 내 언어를 바꾸세요.'
    : auto
      ? `들리는 말을 ${target}로 번역합니다. 상대 언어는 정하지 않습니다.`
      : `${languageLabel(sourceLanguage)}로 들리는 말을 ${target}로 번역합니다.`;

  useEffect(() => {
    (initialFocus === 'start' ? startRef : sourceRef).current?.focus();
  }, [initialFocus]);

  const close = () => onClose(choice);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = Array.from(panelRef.current?.querySelectorAll<HTMLElement>('button, select') ?? []);
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = event.shiftKey ? (index <= 0 ? items.length - 1 : index - 1) : index === items.length - 1 ? 0 : index + 1;
    event.preventDefault();
    items[next]?.focus();
  };

  return (
    <div
      className={styles.overlay}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className={styles.panel}
        onKeyDown={onKeyDown}
      >
        <div className={styles.panelHead}>
          <div className={styles.panelTitleGroup}>
            <h2 id={titleId} className={styles.panelTitle}>
              <span className={styles.panelIcon}>
                <TranslateIcon />
              </span>
              새 번역
            </h2>
            <span id={descriptionId} className={styles.panelDescription}>
              상대방의 말을 번역해 소리와 글로 전합니다. 끝나면 번역 노트로 저장합니다.
            </span>
          </div>
          <button type="button" className={styles.closeButton} aria-label="닫기" onClick={close}>
            <CloseIcon />
          </button>
        </div>

        <div className={styles.panelBody}>
          <div className={styles.languageBlock}>
            <div className={styles.languageRow}>
              <label className={styles.languageField}>
                <span className={styles.languageCaption}>
                  <span className={styles.languageName}>상대 언어</span>
                  <span className={styles.languageRole}>들리는 말</span>
                </span>
                <span className={same ? styles.selectBoxWarn : styles.selectBox}>
                  <select
                    ref={sourceRef}
                    className={styles.select}
                    value={sourceLanguage}
                    onChange={(event) => setChoice({ ...choice, sourceLanguage: event.target.value })}
                  >
                    {SOURCE_LANGUAGES.map((language) => (
                      <option key={language.code} value={language.code}>
                        {language.label}
                      </option>
                    ))}
                  </select>
                  <ChevronIcon />
                </span>
              </label>
              <button
                type="button"
                className={auto ? styles.swapDisabled : styles.swap}
                aria-label="두 언어 맞바꾸기"
                aria-disabled={auto}
                data-tooltip={auto ? '자동 감지는 내 언어가 될 수 없습니다' : undefined}
                onClick={() => {
                  if (!auto) setChoice({ ...choice, sourceLanguage: targetLanguage, targetLanguage: sourceLanguage });
                }}
              >
                <SwapIcon />
              </button>
              <label className={styles.languageField}>
                <span className={styles.languageCaption}>
                  <span className={styles.languageName}>내 언어</span>
                  <span className={styles.languageRole}>번역 결과</span>
                </span>
                <span className={same ? styles.selectBoxWarn : styles.selectBox}>
                  <select
                    className={styles.select}
                    value={targetLanguage}
                    onChange={(event) => setChoice({ ...choice, targetLanguage: event.target.value })}
                  >
                    {TARGET_LANGUAGES.map((language) => (
                      <option key={language.code} value={language.code}>
                        {language.label}
                      </option>
                    ))}
                  </select>
                  <ChevronIcon />
                </span>
              </label>
            </div>
            <span role="status" className={same ? styles.pairLineWarn : styles.pairLine}>
              {pairLine}
            </span>
            <span className={styles.note}>
              상대 언어는 원문 표시와 노트 기록에 쓰입니다. 실제로 들리는 언어를 제한하지는 않습니다. 시작하면 끝날 때까지 두 언어를 바꿀 수 없습니다.
            </span>
          </div>

          <div className={styles.micRow}>
            <span className={styles.micIcon}>
              <MicIcon />
            </span>
            <span>{micLabel}</span>
          </div>

          <div className={styles.speakerBlock}>
            <div className={styles.speakerRow}>
              <div className={styles.speakerText}>
                <span className={styles.languageName}>번역 음성</span>
                <span className={styles.languageRole}>번역을 소리로 들려줍니다. 끄면 화면으로만 봅니다.</span>
              </div>
              <button
                type="button"
                role="switch"
                aria-label="번역 음성"
                aria-checked={speakerOn}
                className={speakerOn ? styles.switchOn : styles.switchOff}
                onClick={() => setChoice({ ...choice, speakerOn: !speakerOn })}
              >
                <span className={styles.switchKnob} />
              </button>
            </div>
            {speakerOn ? (
              <div className={styles.speakerHint}>
                <span>이어폰을 권장합니다. 스피커로 들으면 번역 음성이 저장 녹음에도 섞입니다.</span>
                <span>이 기기 스피커로 나오는 회의를 들을 때는 번역 음성을 끄세요.</span>
              </div>
            ) : null}
          </div>

          <div className={styles.rule} />

          <div className={styles.costNote}>
            <span>음성이 OpenAI로 직접 전송됩니다.</span>
            <span>1시간에 약 $2~3, 내 API 키로 청구됩니다. 스피커를 꺼도 요금은 같습니다.</span>
          </div>
        </div>

        <div className={styles.panelActions}>
          <button type="button" className={styles.secondary} onClick={close}>
            취소
          </button>
          <button
            ref={startRef}
            type="button"
            className={same ? styles.primaryBlocked : styles.primary}
            aria-disabled={same}
            onClick={() => {
              if (!same) onStart(choice);
            }}
          >
            번역 시작
          </button>
        </div>
      </div>
    </div>
  );
};