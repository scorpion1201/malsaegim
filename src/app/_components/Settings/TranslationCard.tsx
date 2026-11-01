'use client';

import { useEffect, useState } from 'react';
import { AsrHttpError, mintTranslationSecret } from '@/app/_lib/asr/directTranscribe';
import { isOpenAiBaseUrl, resolveTranslationKey, type NoiseReduction, type TranslationSettings } from '@/app/_lib/settings/translationSettings';
import type { ByokSettings } from '@/app/_lib/settings/byokSettings';
import { SOURCE_LANGUAGES, TARGET_LANGUAGES } from '@/app/_lib/translation/languages';
import { CheckIcon, CrossIcon, EyeIcon, type TestState } from './parts';
import styles from './Settings.module.css';

type TranslationCardProps = {
  draft: TranslationSettings;
  byok: ByokSettings;
  onChange: (patch: Partial<TranslationSettings>) => void;
};

const TranslateIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 5h9M8.5 3v2M11 5c-.8 3.6-3 6.6-7 8.5M5.5 8.5c1.2 2 3 3.7 5.5 5" />
    <path d="M12 21l4.5-10L21 21M13.6 18h5.8" />
  </svg>
);

const ChevronIcon = () => (
  <svg className={styles.selectChevron} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 9l6 6 6-6" />
  </svg>
);

const MIC_OPTIONS: { value: NoiseReduction; label: string }[] = [
  { value: 'near_field', label: '이어폰' },
  { value: 'far_field', label: '노트북·회의실' },
];

export const TranslationCard = ({ draft, byok, onChange }: TranslationCardProps) => {
  const [showKey, setShowKey] = useState(false);
  const [test, setTest] = useState<TestState>({ kind: 'idle' });

  // 키 안내에서 왔으면 이 카드로 스크롤한다
  useEffect(() => {
    if (window.location.hash === '#translation') document.getElementById('translation')?.scrollIntoView();
  }, []);

  const update = (patch: Partial<TranslationSettings>) => {
    onChange(patch);
    setTest({ kind: 'idle' });
  };

  const runTest = async () => {
    const apiKey = resolveTranslationKey(byok, { ...draft, apiKey: draft.apiKey.trim() });
    if (!apiKey) {
      setTest({ kind: 'fail', detail: 'OpenAI API 키가 필요합니다' });
      return;
    }
    setTest({ kind: 'busy' });
    try {
      await mintTranslationSecret({ apiKey, targetLanguage: draft.targetLanguage, noiseReduction: draft.noiseReduction });
      setTest({ kind: 'ok' });
    } catch (error) {
      const detail =
        error instanceof AsrHttpError ? `${error.status} · ${error.message}` : error instanceof Error ? error.message : String(error);
      setTest({ kind: 'fail', detail });
    }
  };

  return (
    <section id="translation" className={styles.card}>
      <div className={styles.cardText}>
        <span className={styles.cardTitle}>
          <span className={styles.cardIcon}>
            <TranslateIcon />
          </span>
          실시간 번역
        </span>
        <span className={styles.cardDescription}>
          OpenAI 실시간 번역을 사용합니다. 음성은 브라우저에서 OpenAI로 직접 전송되고 말새김 서버를 거치지 않습니다.
        </span>
      </div>

      <label className={styles.field}>
        OpenAI API 키
        <span className={styles.inputBox}>
          <input
            className={styles.input}
            type={showKey ? 'text' : 'password'}
            value={draft.apiKey}
            placeholder="sk-로 시작하는 키"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => update({ apiKey: event.target.value })}
          />
          <button
            type="button"
            className={styles.eye}
            aria-label={showKey ? '키 숨기기' : '키 보기'}
            aria-pressed={showKey}
            onClick={() => setShowKey((v) => !v)}
          >
            <EyeIcon open={showKey} />
          </button>
        </span>
        <span className={styles.hint}>
          {isOpenAiBaseUrl(byok.baseUrl) && byok.apiKey ? '비워 두면 위 BYOK 키를 씁니다' : 'OpenAI API 키가 필요합니다'}. 키는 이 브라우저에 암호화해 저장됩니다
        </span>
      </label>

      <div className={styles.fieldPair}>
        <label className={styles.field}>
          상대 언어 기본값
          <span className={styles.selectBox}>
            <select className={styles.select} value={draft.sourceLanguage} onChange={(event) => update({ sourceLanguage: event.target.value })}>
              {SOURCE_LANGUAGES.map((language) => (
                <option key={language.code} value={language.code}>
                  {language.label}
                </option>
              ))}
            </select>
            <ChevronIcon />
          </span>
          <span className={styles.hint}>시작 패널의 기본값입니다</span>
        </label>
        <label className={styles.field}>
          내 언어 기본값
          <span className={styles.selectBox}>
            <select className={styles.select} value={draft.targetLanguage} onChange={(event) => update({ targetLanguage: event.target.value })}>
              {TARGET_LANGUAGES.map((language) => (
                <option key={language.code} value={language.code}>
                  {language.label}
                </option>
              ))}
            </select>
            <ChevronIcon />
          </span>
          <span className={styles.hint}>시작 패널의 기본값입니다</span>
        </label>
      </div>

      <div className={styles.field}>
        마이크 환경
        <div className={styles.segments} role="group" aria-label="마이크 환경">
          {MIC_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={draft.noiseReduction === option.value ? styles.segmentActive : styles.segment}
              aria-pressed={draft.noiseReduction === option.value}
              onClick={() => update({ noiseReduction: option.value })}
            >
              {option.label}
            </button>
          ))}
        </div>
        <span className={styles.hint}>소음 제거 방식을 정합니다</span>
      </div>

      <span className={styles.hint}>요금은 1시간에 약 $2~3입니다. 스피커를 꺼도 같습니다.</span>

      <div className={styles.testRow}>
        <button type="button" className={styles.secondary} disabled={test.kind === 'busy'} onClick={() => void runTest()}>
          {test.kind === 'busy' ? '연결 확인 중…' : '연결 테스트'}
        </button>
        {test.kind === 'ok' ? (
          <span className={styles.testOk}>
            <CheckIcon />
            연결 성공
          </span>
        ) : test.kind === 'fail' ? (
          <span className={styles.testFail}>
            <CrossIcon />
            연결 실패
            <span className={styles.testDetail}>· {test.detail}</span>
          </span>
        ) : null}
      </div>
    </section>
  );
};