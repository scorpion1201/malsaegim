'use client';

import { useEffect, useState } from 'react';
import { isByokComplete, readByokSettings } from '@/app/_lib/settings/byokSettings';
import { TranscribeWorkspace } from '../Workspace/TranscribeWorkspace';
import { ModelDownloadCard } from './ModelDownloadCard';
import { useModelDownload } from './ModelProvider';
import { ModelSplash } from './ModelSplash';

const BACKGROUND_KEY = 'malsaegim:models:background';

const readBackground = (): boolean => {
  try {
    return sessionStorage.getItem(BACKGROUND_KEY) === '1';
  } catch {
    return false;
  }
};

const writeBackground = (): void => {
  try {
    sessionStorage.setItem(BACKGROUND_KEY, '1');
  } catch {
    // ignore
  }
};

/**
 * `/` 의 분기: API 설정이 없고 모델도 없으면 스플래시에서 바로 내려받고, 그 밖에는 에디터.
 * "백그라운드에서 계속" 은 이 탭(sessionStorage)에 기억해 새로고침해도 에디터 + 플로팅 카드로 간다.
 */
export const HomeGate = () => {
  const model = useModelDownload();
  const [mounted, setMounted] = useState(false);
  const [background, setBackground] = useState(false);
  const [byok, setByok] = useState(false);
  /** 이번 마운트에서 스플래시를 한 번이라도 보였는지 — 보였다면 ready 가 돼도 "준비가 끝났습니다" 를 거쳐 나간다 */
  const [shown, setShown] = useState(false);

  useEffect(() => {
    // localStorage·sessionStorage 는 서버 렌더와 다를 수 있어 마운트 뒤에 읽는다
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBackground(readBackground());
    setByok(isByokComplete(readByokSettings()));
    setMounted(true);
  }, []);

  const needsModel = !byok && model.status !== 'unavailable' && model.status !== 'unknown';
  const splash = mounted && needsModel && !background && (model.status !== 'ready' || shown);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (splash) setShown(true);
  }, [splash]);

  // 스플래시가 뜬 첫 방문은 자동으로 내려받기 시작한다
  const { status, start } = model;
  useEffect(() => {
    if (splash && status === 'missing') start();
  }, [splash, status, start]);

  if (!mounted) return null;
  if (!byok && model.status === 'unknown') return null;
  if (splash) {
    return (
      <ModelSplash
        onBackground={() => {
          writeBackground();
          setBackground(true);
        }}
        onEnter={() => setBackground(true)}
      />
    );
  }
  return (
    <>
      <TranscribeWorkspace />
      <ModelDownloadCard />
    </>
  );
};