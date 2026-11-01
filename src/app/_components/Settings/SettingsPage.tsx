'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { whenApiKeysReady } from '@/app/_lib/settings/apiKeyStore';
import { ASR_LANGUAGE, AsrHttpError, transcribeDirect } from '@/app/_lib/asr/directTranscribe';
import { RECORDING_SAMPLE_RATE, encodeWavPcm16 } from '@/app/_lib/audio/wav';
import {
  EMPTY_BYOK_SETTINGS,
  isByokComplete,
  readByokSettings,
  writeByokSettings,
  type ByokSettings,
} from '@/app/_lib/settings/byokSettings';
import { readWorkspaceState, type WorkspaceTab } from '@/app/_lib/settings/workspaceState';
import {
  DEFAULT_TRANSLATION_SETTINGS,
  readTranslationSettings,
  writeTranslationSettings,
  type TranslationSettings,
} from '@/app/_lib/settings/translationSettings';
import { ThemeToggle } from '../ThemeToggle/ThemeToggle';
import { useToast } from '../Toast/ToastProvider';
import { OnDeviceModelCard } from './OnDeviceModelCard';
import { CheckIcon, CrossIcon, EyeIcon, type TestState } from './parts';
import { TranslationCard } from './TranslationCard';
import { GearIcon } from '../Workspace/GearIcon';
import topStyles from '../Workspace/Workspace.module.css';
import styles from './Settings.module.css';

const sameSettings = (a: ByokSettings, b: ByokSettings): boolean =>
  a.apiKey === b.apiKey && a.baseUrl === b.baseUrl && a.model === b.model;

const trimAll = (s: ByokSettings): ByokSettings => ({
  apiKey: s.apiKey.trim(),
  baseUrl: s.baseUrl.trim(),
  model: s.model.trim(),
});

const KeyIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="8" cy="15" r="4" />
    <path d="M10.8 12.2 20 3M15 8l3 3M18 5l3 3" />
  </svg>
);

/** 1초 무음 WAV — 연결 테스트용 (키·주소·모델이 맞으면 빈 텍스트가 돌아온다) */
const silentTestWav = (): Uint8Array => encodeWavPcm16(new Int16Array(RECORDING_SAMPLE_RATE), RECORDING_SAMPLE_RATE);

const SettingsForm = () => {
  const toast = useToast();
  // 첫 렌더에서 localStorage 를 읽는다 — 서버 렌더와 다를 수 있어 이 페이지는 클라이언트 전용이다
  const [saved, setSaved] = useState<ByokSettings>(() => readByokSettings());
  const [draft, setDraft] = useState<ByokSettings>(saved);
  const [showKey, setShowKey] = useState(false);
  const [test, setTest] = useState<TestState>({ kind: 'idle' });

  const [savedTranslation, setSavedTranslation] = useState<TranslationSettings>(() => readTranslationSettings());
  const [translationDraft, setTranslationDraft] = useState<TranslationSettings>(savedTranslation);
  const [backTab, setBackTab] = useState<WorkspaceTab>('transcribe');

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBackTab(readWorkspaceState().tab);
  }, []);

  const dirty =
    !sameSettings(trimAll(draft), saved) ||
    JSON.stringify({ ...translationDraft, apiKey: translationDraft.apiKey.trim() }) !== JSON.stringify(savedTranslation);
  const keyed = isByokComplete(saved);

  const update = (patch: Partial<ByokSettings>) => {
    setDraft((previous) => ({ ...previous, ...patch }));
    setTest({ kind: 'idle' });
  };

  const save = () => {
    const next = writeByokSettings(draft);
    setSaved(next);
    setDraft(next);
    const nextTranslation = writeTranslationSettings(translationDraft);
    setSavedTranslation(nextTranslation);
    setTranslationDraft(nextTranslation);
    toast.show(
      isByokComplete(next)
        ? { kind: 'success', title: '설정을 저장했습니다', description: '다음 인식부터 이 설정으로 요청합니다' }
        : { kind: 'info', title: '설정을 저장했습니다', description: '세 항목을 모두 채우기 전까지는 온디바이스 인식을 사용합니다' },
    );
  };

  const reset = () => {
    setDraft(EMPTY_BYOK_SETTINGS);
    setTranslationDraft(DEFAULT_TRANSLATION_SETTINGS);
    setTest({ kind: 'idle' });
  };

  const runTest = async () => {
    const candidate = trimAll(draft);
    if (!isByokComplete(candidate)) {
      setTest({ kind: 'fail', detail: 'API Base URL · API Key · 모델 이름을 모두 입력하세요' });
      return;
    }
    setTest({ kind: 'busy' });
    try {
      await transcribeDirect(silentTestWav(), { ...candidate, language: ASR_LANGUAGE });
      setTest({ kind: 'ok' });
    } catch (error) {
      const detail =
        error instanceof AsrHttpError ? `${error.status} · ${error.message}` : error instanceof Error ? error.message : String(error);
      const translationModel = /^gpt-realtime-translate/i.test(candidate.model);
      setTest({ kind: 'fail', detail: translationModel ? `${detail} · 번역 모델은 아래 실시간 번역 설정을 쓰세요` : detail });
    }
  };

  return (
    <div className={styles.page}>
      <header className={`${topStyles.topBar} ${topStyles.topBarLined}`}>
        <div className={topStyles.topLeft}>
          <Link href="/" className={topStyles.logo} draggable={false} aria-label="말새김 홈">
            <Image src="/app-logo.png" alt="" width={44} height={44} priority draggable={false} className={topStyles.logoMark} />
            말새김
          </Link>
        </div>
        <div className={topStyles.topRight}>
          <Link href="/" className={styles.backLink}>
            {backTab === 'translate' ? '실시간 번역으로' : '받아쓰기로'} 돌아가기
          </Link>
          <div className={topStyles.themeSlot}>
            <ThemeToggle />
          </div>
          <Link href="/" className={topStyles.gearButtonActive} aria-label="설정 닫기" data-tooltip="에디터로 돌아가기">
            <GearIcon />
          </Link>
        </div>
      </header>

      <main className={styles.main}>
        <div className={styles.column}>
          <h1 className={styles.title}>설정</h1>

          <OnDeviceModelCard />

          <section className={styles.card}>
            <div className={styles.cardHead}>
              <div className={styles.cardText}>
                <span className={styles.cardTitle}>
                  <span className={styles.cardIcon}>
                    <KeyIcon />
                  </span>
                  음성 인식 API (BYOK)
                </span>
                <span className={styles.cardDescription}>
                  음성 인식을 사용하기 위한 API를 설정합니다. 설정된 키는 브라우저(On-Device)에만 저장됩니다.
                  <br />
                  비워두면 온디바이스 인식을 사용합니다.
                </span>
              </div>
              <span className={keyed ? styles.pillOk : styles.pillAccent}>
                <span className={styles.pillDot} />
                {keyed ? '내 키 사용 중' : '온디바이스 사용 중'}
              </span>
            </div>

            <label className={styles.field}>
              API Base URL
              <span className={styles.inputBox}>
                <input
                  className={`${styles.input} ${styles.mono}`}
                  type="url"
                  value={draft.baseUrl}
                  placeholder="https://api.openai.com/v1"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => update({ baseUrl: event.target.value })}
                />
              </span>
              <span className={styles.hint}>OpenAI API 호환 엔드포인트</span>
            </label>

            <label className={styles.field}>
              API Key
              <span className={styles.inputBox}>
                <input
                  className={styles.input}
                  type={showKey ? 'text' : 'password'}
                  value={draft.apiKey}
                  placeholder="sk-••••••••••••••••••••••••••••••••••••••••••••••••"
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
              <span className={styles.hint}>입력한 키는 이 브라우저에 암호화해 저장됩니다. 공용 PC에서는 사용 후 지워 주세요</span>
            </label>

            <label className={styles.field}>
              모델 이름
              <span className={styles.inputBox}>
                <input
                  className={`${styles.input} ${styles.mono}`}
                  type="text"
                  value={draft.model}
                  placeholder="gpt-realtime-whisper"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => update({ model: event.target.value })}
                />
              </span>
              <span className={styles.hint}>음성 인식 모델 이름. 예: gpt-realtime-whisper</span>
            </label>

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

          <TranslationCard
            draft={translationDraft}
            byok={trimAll(draft)}
            onChange={(patch) => setTranslationDraft((previous) => ({ ...previous, ...patch }))}
          />

          <div className={styles.actions}>
            <button type="button" className={styles.secondary} onClick={reset} data-tooltip="입력을 모두 비웁니다">
              초기화
            </button>
            <button type="button" className={styles.primary} disabled={!dirty} onClick={save}>
              저장
            </button>
          </div>
        </div>
      </main>
    </div>
  );
};

/** 금고에서 키를 읽은 뒤에 폼을 그린다 — 먼저 그리면 저장된 키가 빈 값으로 보인다 */
export const SettingsPage = () => {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    void whenApiKeysReady().then(() => setReady(true));
  }, []);

  return ready ? <SettingsForm /> : null;
};