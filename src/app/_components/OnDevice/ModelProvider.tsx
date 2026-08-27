'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ModelIntegrityError,
  ModelNetworkError,
  ModelQuotaError,
  deleteModels,
  detectCapabilities,
  downloadModels,
  fetchManifest,
  isComplete,
  purgeOtherVersions,
  readModelState,
  type ModelManifest,
  type OnDeviceCapabilities,
} from '@/app/_lib/engine/malsaegimEngine';

export type ModelStatus = 'unknown' | 'missing' | 'downloading' | 'ready' | 'error' | 'unavailable';

export type ModelContextValue = {
  status: ModelStatus;
  manifest: ModelManifest | null;
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
  // 서버 렌더에서는 알 수 없다 — 클라이언트 첫 렌더에서 계산한다 (렌더 결과에는 쓰지 않으므로 hydration 과 무관)
  const [capabilities] = useState<OnDeviceCapabilities>(() =>
    typeof window === 'undefined' ? UNKNOWN_CAPABILITIES : detectCapabilities(),
  );
  const [received, setReceived] = useState(0);
  const [etaSec, setEtaSec] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [justReady, setJustReady] = useState(false);

  const statusRef = useRef<ModelStatus>('unknown');
  const manifestRef = useRef<ModelManifest | null>(null);
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

  // 최초: 능력 → manifest → 캐시 상태
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
        manifestRef.current = found;
        setManifest(found);
        if (readModelState()?.version !== found.version) await purgeOtherVersions(found);
        const complete = await isComplete(found);
        if (cancelled) return;
        setReceived(complete ? found.totalBytes : 0);
        setStatusBoth(complete ? 'ready' : 'missing');
      } catch (error) {
        if (cancelled) return;
        setMessage(describe(error));
        setStatusBoth('unavailable');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [capabilities, setStatusBoth]);

  const start = useCallback(() => {
    const found = manifestRef.current;
    if (!found || statusRef.current === 'downloading' || statusRef.current === 'ready') return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setMessage(null);
    setStatusBoth('downloading');
    downloadModels(found, {
      signal: controller.signal,
      onProgress: (progress) => {
        setReceived(progress.receivedBytes);
        setEtaSec(progress.etaSec);
      },
    })
      .then(() => {
        setReceived(found.totalBytes);
        setEtaSec(null);
        setJustReady(true);
        setStatusBoth('ready');
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
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
    await deleteModels();
    setReceived(0);
    setEtaSec(null);
    setMessage(null);
    setStatusBoth(manifestRef.current ? 'missing' : 'unavailable');
  }, [setStatusBoth]);

  const whenReady = useCallback((): Promise<boolean> => {
    const current = statusRef.current;
    if (current === 'ready') return Promise.resolve(true);
    if (current === 'unavailable') return Promise.resolve(false);
    const waiting = new Promise<boolean>((resolve) => waitersRef.current.push(resolve));
    if (current === 'missing' || current === 'error') start();
    return waiting;
  }, [start]);

  const totalBytes = manifest?.totalBytes ?? 0;
  const value = useMemo<ModelContextValue>(
    () => ({
      status,
      manifest,
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
      whenReady,
    }),
    [status, manifest, capabilities, received, totalBytes, etaSec, message, justReady, start, remove, whenReady],
  );

  return <ModelContext.Provider value={value}>{children}</ModelContext.Provider>;
};

export const useModelDownload = (): ModelContextValue => {
  const value = useContext(ModelContext);
  if (!value) throw new Error('useModelDownload 는 ModelProvider 안에서만 쓸 수 있습니다');
  return value;
};