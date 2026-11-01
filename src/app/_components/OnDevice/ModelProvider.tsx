'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ModelIntegrityError,
  ModelNetworkError,
  ModelQuotaError,
  autoModel,
  bundleFor,
  deleteModels,
  detectCapabilities,
  detectDeviceProfile,
  downloadModels,
  fetchManifest,
  isComplete,
  purgeExcept,
  purgeStale,
  readModelChoice,
  resolveModel,
  shutdownWhisperWorker,
  writeModelChoice,
  type DeviceProfile,
  type ModelBundle,
  type ModelChoice,
  type ModelManifest,
  type OnDeviceCapabilities,
  type WhisperModel,
} from '@/app/_lib/engine/malsaegimEngine';

export type ModelStatus = 'unknown' | 'missing' | 'downloading' | 'ready' | 'error' | 'unavailable';

export type ModelContextValue = {
  status: ModelStatus;
  manifest: ModelManifest | null;
  /** 이 기기에 내려받는(받은) 묶음 — 엔진 런타임 + 고른 모델 하나. 실시간·파일 전사가 함께 쓴다 */
  bundle: ModelBundle | null;
  /** 고를 수 있는 모델들과 지금 고른 것 */
  models: WhisperModel[];
  selected: WhisperModel | null;
  /** 자동(기기 판별)으로 고르는 모델 */
  autoSelected: WhisperModel | null;
  choice: ModelChoice;
  device: DeviceProfile | null;
  capabilities: OnDeviceCapabilities;
  receivedBytes: number;
  totalBytes: number;
  percent: number;
  etaSec: number | null;
  /** error / unavailable 의 이유 */
  message: string | null;
  /** downloading → ready 로 바뀐 뒤 3초 동안 true (완료 안내용) */
  justReady: boolean;
  start: () => void;
  retry: () => void;
  remove: () => Promise<void>;
  /** 모델을 바꾼다 ('auto' = 기기 판별). 받아 둔 다른 모델은 새 모델을 다 받은 뒤 지운다 */
  choose: (choice: ModelChoice) => Promise<void>;
  /** ready 면 즉시 true. missing/error 면 내려받기를 시작하고 끝날 때까지 기다린다. 실패·불가면 false */
  whenReady: () => Promise<boolean>;
};

const ModelContext = createContext<ModelContextValue | null>(null);
const JUST_READY_MS = 3000;
const UNKNOWN_CAPABILITIES: OnDeviceCapabilities = { supported: true, threads: true, reason: null };

const describe = (error: unknown): string => {
  if (error instanceof ModelQuotaError || error instanceof ModelNetworkError) return error.message;
  if (error instanceof ModelIntegrityError) return `${error.message} — 다시 시도하세요`;
  return error instanceof Error ? error.message : String(error);
};

export const ModelProvider = ({ children }: { children: ReactNode }) => {
  const [status, setStatus] = useState<ModelStatus>('unknown');
  const [manifest, setManifest] = useState<ModelManifest | null>(null);
  const [bundle, setBundle] = useState<ModelBundle | null>(null);
  const [choice, setChoice] = useState<ModelChoice>('auto');
  const [device, setDevice] = useState<DeviceProfile | null>(null);
  // 서버 렌더에서는 알 수 없다 — 클라이언트 첫 렌더에서 계산한다 (렌더 결과에는 쓰지 않으므로 hydration 과 무관)
  const [capabilities] = useState<OnDeviceCapabilities>(() =>
    typeof window === 'undefined' ? UNKNOWN_CAPABILITIES : detectCapabilities(),
  );
  const [received, setReceived] = useState(0);
  const [etaSec, setEtaSec] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [justReady, setJustReady] = useState(false);

  const statusRef = useRef<ModelStatus>('unknown');
  const bundleRef = useRef<ModelBundle | null>(null);
  const manifestRef = useRef<ModelManifest | null>(null);
  const deviceRef = useRef<DeviceProfile | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const waitersRef = useRef<Array<(ok: boolean) => void>>([]);
  const startRef = useRef<() => void>(() => {});

  const setStatusBoth = useCallback((next: ModelStatus) => {
    statusRef.current = next;
    setStatus(next);
    if (next === 'ready' || next === 'error' || next === 'unavailable') {
      const ok = next === 'ready';
      waitersRef.current.splice(0).forEach((resolve) => resolve(ok));
    } else if (next === 'missing' && waitersRef.current.length > 0) {
      // 초기화 중에 whenReady 가 불렸다면 바로 내려받기 시작
      queueMicrotask(() => startRef.current());
    }
  }, []);

  /** 묶음을 정하고 캐시 상태로 ready/missing 을 정한다. 다 받아 둔 묶음이면 다른 모델 파일은 지운다 */
  const adopt = useCallback(
    async (next: ModelBundle): Promise<boolean> => {
      bundleRef.current = next;
      setBundle(next);
      const complete = await isComplete(next);
      if (bundleRef.current !== next) return false;
      if (complete) await purgeExcept(next.files).catch(() => undefined);
      setReceived(complete ? next.totalBytes : 0);
      setStatusBoth(complete ? 'ready' : 'missing');
      return complete;
    },
    [setStatusBoth],
  );

  // 최초: 능력 → manifest → 기기·선택 → 캐시 상태
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!capabilities.supported) {
        setMessage(capabilities.reason);
        setStatusBoth('unavailable');
        return;
      }
      try {
        const found = await fetchManifest();
        if (cancelled) return;
        if (!found) {
          setMessage('서버에 모델이 없습니다');
          setStatusBoth('unavailable');
          return;
        }
        const profile = detectDeviceProfile();
        const saved = readModelChoice();
        manifestRef.current = found;
        deviceRef.current = profile;
        setManifest(found);
        setDevice(profile);
        setChoice(saved);
        // 이전 버전 파일만 지운다 — 받아 둔 현재 버전 모델은 모델을 바꾸는 중일 수 있어 남긴다
        await purgeStale(found);
        if (cancelled) return;
        await adopt(bundleFor(found, resolveModel(found, saved, profile)));
      } catch (error) {
        if (cancelled) return;
        setMessage(describe(error));
        setStatusBoth('unavailable');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [capabilities, setStatusBoth, adopt]);

  const start = useCallback(() => {
    const target = bundleRef.current;
    if (!target || statusRef.current === 'downloading' || statusRef.current === 'ready') return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setMessage(null);
    setStatusBoth('downloading');
    downloadModels(target, {
      signal: controller.signal,
      onProgress: (progress) => {
        setReceived(progress.receivedBytes);
        setEtaSec(progress.etaSec);
      },
    })
      .then(async () => {
        if (bundleRef.current !== target) return;
        // 새 모델을 다 받았으니 이전 모델 파일을 지워 저장 공간을 돌려준다
        await purgeExcept(target.files).catch(() => undefined);
        setReceived(target.totalBytes);
        setEtaSec(null);
        setJustReady(true);
        setStatusBoth('ready');
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || bundleRef.current !== target) return;
        setMessage(describe(error));
        setStatusBoth('error');
      });
  }, [setStatusBoth]);

  useEffect(() => {
    startRef.current = start;
  }, [start]);

  useEffect(() => {
    if (!justReady) return;
    const timer = setTimeout(() => setJustReady(false), JUST_READY_MS);
    return () => clearTimeout(timer);
  }, [justReady]);

  const remove = useCallback(async () => {
    controllerRef.current?.abort();
    shutdownWhisperWorker();
    await deleteModels();
    setReceived(0);
    setEtaSec(null);
    setMessage(null);
    setStatusBoth(bundleRef.current ? 'missing' : 'unavailable');
  }, [setStatusBoth]);

  const choose = useCallback(
    async (next: ModelChoice) => {
      const found = manifestRef.current;
      const profile = deviceRef.current;
      if (!found || !profile) return;
      writeModelChoice(next);
      setChoice(next);
      const target = bundleFor(found, resolveModel(found, next, profile));
      if (target.key === bundleRef.current?.key) return;
      const wasDownloading = statusRef.current === 'downloading';
      controllerRef.current?.abort();
      // 올라가 있는 모델을 내린다 — 다음 인식부터 새 모델로 띄운다
      shutdownWhisperWorker();
      setEtaSec(null);
      setMessage(null);
      const complete = await adopt(target);
      if (!complete && wasDownloading) startRef.current();
    },
    [adopt],
  );

  const whenReady = useCallback((): Promise<boolean> => {
    const current = statusRef.current;
    if (current === 'ready') return Promise.resolve(true);
    if (current === 'unavailable') return Promise.resolve(false);
    const waiting = new Promise<boolean>((resolve) => waitersRef.current.push(resolve));
    if (current === 'missing' || current === 'error') start();
    return waiting;
  }, [start]);

  const totalBytes = bundle?.totalBytes ?? 0;
  const value = useMemo<ModelContextValue>(
    () => ({
      status,
      manifest,
      bundle,
      models: manifest?.models ?? [],
      selected: bundle?.model ?? null,
      autoSelected: manifest && device ? autoModel(manifest, device) : null,
      choice,
      device,
      capabilities,
      receivedBytes: received,
      totalBytes,
      percent: totalBytes > 0 ? Math.min(100, Math.floor((received / totalBytes) * 100)) : 0,
      etaSec,
      message,
      justReady,
      start,
      retry: start,
      remove,
      choose,
      whenReady,
    }),
    [status, manifest, bundle, choice, device, capabilities, received, totalBytes, etaSec, message, justReady, start, remove, choose, whenReady],
  );

  return <ModelContext.Provider value={value}>{children}</ModelContext.Provider>;
};

export const useModelDownload = (): ModelContextValue => {
  const value = useContext(ModelContext);
  if (!value) throw new Error('useModelDownload 는 ModelProvider 안에서만 쓸 수 있습니다');
  return value;
};