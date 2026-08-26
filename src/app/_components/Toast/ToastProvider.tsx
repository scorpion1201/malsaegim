'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import styles from './Toast.module.css';

export type ToastKind = 'success' | 'info' | 'progress' | 'error';

export type ToastInput = {
  kind: ToastKind;
  title: string;
  description?: string;
  /** 0–100. progress 종류에서 막대로 표시 */
  progress?: number;
  /** 우측 작은 텍스트 (예: "7/16") */
  meta?: string;
  actions?: Array<{ label: string; onClick: () => void; primary?: boolean }>;
  /** ms. 0 이면 수동으로 닫을 때까지 유지. 기본: success/info 4000, error 8000, progress 0 */
  duration?: number;
};

export type Toast = ToastInput & { id: string };

type ToastApi = {
  show: (toast: ToastInput & { id?: string }) => string;
  update: (id: string, patch: Partial<ToastInput>) => void;
  dismiss: (id: string) => void;
};

const ToastContext = createContext<ToastApi | null>(null);

const defaultDuration = (kind: ToastKind): number =>
  kind === 'progress' ? 0 : kind === 'error' ? 8000 : 4000;

const Icon = ({ kind }: { kind: ToastKind }) => {
  if (kind === 'success') {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 12l5 5L20 7" />
      </svg>
    );
  }
  if (kind === 'progress') {
    return (
      <svg className={styles.spin} width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
        <path d="M12 3a9 9 0 1 0 9 9" />
      </svg>
    );
  }
  if (kind === 'error') {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
        <path d="M12 8v5M12 16.5v.5" />
      </svg>
    );
  }
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <path d="M12 11v5M12 7.5v.5" />
    </svg>
  );
};

const iconClass: Record<ToastKind, string> = {
  success: styles.iconSuccess,
  info: styles.iconInfo,
  progress: styles.iconProgress,
  error: styles.iconError,
};

export const ToastProvider = ({ children }: { children: ReactNode }) => {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const counter = useRef(0);
  const toastsRef = useRef<Toast[]>([]);
  useEffect(() => {
    toastsRef.current = toasts;
  }, [toasts]);

  const clearTimer = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
  }, []);

  const dismiss = useCallback(
    (id: string) => {
      clearTimer(id);
      setToasts((previous) => previous.filter((toast) => toast.id !== id));
    },
    [clearTimer],
  );

  const arm = useCallback(
    (id: string, kind: ToastKind, duration?: number) => {
      clearTimer(id);
      const ms = duration ?? defaultDuration(kind);
      if (ms > 0) timers.current.set(id, setTimeout(() => dismiss(id), ms));
    },
    [clearTimer, dismiss],
  );

  const show = useCallback(
    (input: ToastInput & { id?: string }) => {
      counter.current += 1;
      const id = input.id ?? `toast-${counter.current}`;
      const toast: Toast = { ...input, id };
      setToasts((previous) => [...previous.filter((t) => t.id !== id), toast]);
      arm(id, toast.kind, toast.duration);
      return id;
    },
    [arm],
  );

  const update = useCallback(
    (id: string, patch: Partial<ToastInput>) => {
      setToasts((previous) => previous.map((toast) => (toast.id === id ? { ...toast, ...patch } : toast)));
      if (patch.kind !== undefined || patch.duration !== undefined) {
        const current = toastsRef.current.find((toast) => toast.id === id);
        if (current) {
          const merged = { ...current, ...patch };
          arm(id, merged.kind, merged.duration);
        }
      }
    },
    [arm],
  );

  const api = useMemo(() => ({ show, update, dismiss }), [show, update, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className={styles.stack} aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={styles.toast} role={toast.kind === 'error' ? 'alert' : 'status'}>
            <div className={styles.row}>
              <span className={`${styles.icon} ${iconClass[toast.kind]}`}>
                <Icon kind={toast.kind} />
              </span>
              <div className={styles.body}>
                <span className={styles.title}>{toast.title}</span>
                {toast.description ? <span className={styles.description}>{toast.description}</span> : null}
                {toast.actions && toast.actions.length > 0 ? (
                  <div className={styles.actions}>
                    {toast.actions.map((action) => (
                      <button
                        key={action.label}
                        type="button"
                        className={action.primary ? styles.actionPrimary : styles.action}
                        onClick={() => {
                          action.onClick();
                          dismiss(toast.id);
                        }}
                      >
                        {action.label}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
              {toast.meta ? <span className={styles.meta}>{toast.meta}</span> : null}
              {toast.kind !== 'progress' ? (
                <button type="button" className={styles.close} aria-label="닫기" onClick={() => dismiss(toast.id)}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </button>
              ) : null}
            </div>
            {toast.kind === 'progress' ? (
              <div className={styles.bar}>
                <div className={styles.barFill} style={{ width: `${Math.max(0, Math.min(100, toast.progress ?? 0))}%` }} />
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
};

export const useToast = (): ToastApi => {
  const api = useContext(ToastContext);
  if (!api) throw new Error('useToast must be used inside ToastProvider');
  return api;
};