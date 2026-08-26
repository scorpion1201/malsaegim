'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useState } from 'react';
import { ASR_LANGUAGE, AsrHttpError, transcribeDirect } from '@/app/_lib/asr/directTranscribe';
import { RECORDING_SAMPLE_RATE, encodeWavPcm16 } from '@/app/_lib/audio/wav';
import {
  EMPTY_BYOK_SETTINGS,
  isByokComplete,
  readByokSettings,
  writeByokSettings,
  type ByokSettings,
} from '@/app/_lib/settings/byokSettings';
import { ThemeToggle } from '../ThemeToggle/ThemeToggle';
import { useToast } from '../Toast/ToastProvider';
import { GearIcon } from '../Workspace/GearIcon';
import topStyles from '../Workspace/Workspace.module.css';
import styles from './Settings.module.css';

type TestState = { kind: 'idle' } | { kind: 'busy' } | { kind: 'ok' } | { kind: 'fail'; detail: string };

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

const EyeIcon = ({ open }: { open: boolean }) => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z" />
    <circle cx="12" cy="12" r="3" />
    {open ? null : <path d="M4 4l16 16" />}
  </svg>
);

const CheckIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 12l5 5L20 7" />
  </svg>
);

const CrossIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

/** 1초 무음 WAV — 연결 테스트용 (키·주소·모델이 맞으면 빈 텍스트가 돌아온다) */
const silentTestWav = (): Uint8Array => encodeWavPcm16(new Int16Array(RECORDING_SAMPLE_RATE), RECORDING_SAMPLE_RATE);

export const SettingsPage = () => {
  const toast = useToast();
  // 첫 렌더에서 localStorage 를 읽는다 — 서버 렌더와 다를 수 있어 이 페이지는 클라이언트 전용이다
  const [saved, setSaved] = useState<ByokSettings>(() => readByokSettings());
  const [draft, setDraft] = useState<ByokSettings>(saved);
  const [showKey, setShowKey] = useState(false);
  const [test, setTest] = useState<TestState>({ kind: 'idle' });

  const dirty = !sameSettings(trimAll(draft), saved);
  const keyed = isByokComplete(saved);

  const update = (patch: Partial<ByokSettings>) => {
    setDraft((previous) => ({ ...previous, ...patch }));
    setTest({ kind: 'idle' });
  };

  const save = () => {
    const next = writeByokSettings(draft);
    setSaved(next);
    setDraft(next);
    toast.show(
      isByokComplete(next)
        ? { kind: 'success', title: '설정을 저장했습니다', description: '다음 인식부터 이 설정으로 요청합니다' }
        : { kind: 'info', title: '설정을 저장했습니다', description: '세 항목을 모두 채우기 전까지는 음성 인식을 할 수 없습니다' },
    );
  };

  const reset = () => {
    setDraft(EMPTY_BYOK_SETTINGS);
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
      setTest({ kind: 'fail', detail });
    }
  };

  return (
    <div className={styles.page}>
      <header className={topStyles.topBar}>
        <div className={topStyles.topLeft}>
          <Link href="/" className={topStyles.logo} draggable={false} aria-label="말새김 홈">
            <Image src="/app-logo.png" alt="" width={44} height={44} priority draggable={false} className={topStyles.logoMark} />
            말새김
          </Link>
        </div>
        <div className={topStyles.topRight}>
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
                  <strong className={styles.cardWarning}>비워두면 음성 인식을 할 수 없습니다.</strong>
                </span>
              </div>
              <span className={keyed ? styles.pillOk : styles.pillWarn}>
                <span className={styles.pillDot} />
                {keyed ? '내 키 사용 중' : '설정 필요'}
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
              <span className={styles.hint}>입력한 키는 이 브라우저에만 저장됩니다. 공용 PC에서는 사용 후 지워 주세요</span>
            </label>

            <label className={styles.field}>
              모델 이름
              <span className={styles.inputBox}>
                <input
                  className={`${styles.input} ${styles.mono}`}
                  type="text"
                  value={draft.model}
                  placeholder="gpt-4o-transcribe"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => update({ model: event.target.value })}
                />
              </span>
              <span className={styles.hint}>음성 인식 모델 이름. 예: gpt-4o-transcribe</span>
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