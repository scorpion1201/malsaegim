'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import styles from './Dialog.module.css';

export type ConfirmOptions = {
  /** danger = 빨간 아이콘·빨간 확인 버튼 (삭제 등 되돌릴 수 없는 일) */
  kind?: 'info' | 'danger';
  title: string;
  description?: string;
  /** 본문 아래 빨간 굵은 글씨 한 줄 (예: "이 작업은 되돌릴 수 없습니다.") */
  warning?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Enter 와 첫 포커스가 향하는 쪽. 진행 중인 일을 끝내는 확인은 'cancel' 로 둔다 */
  defaultAction?: 'confirm' | 'cancel';
};

/** 세 갈래 선택 — 취소 · 다른 선택(alternate) · 확인. 취소 옆에 alternate 버튼이 하나 더 생긴다 */
export type ChooseOptions = Omit<ConfirmOptions, 'defaultAction'> & { alternateLabel: string };
export type ChooseResult = 'confirm' | 'alternate' | 'cancel';

type DialogApi = {
  /** 브라우저 window.confirm 대체 — 확인이면 true */
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  /** 확인·다른 선택·취소 중 하나 */
  choose: (options: ChooseOptions) => Promise<ChooseResult>;
};

type Pending = { options: ConfirmOptions & { alternateLabel?: string }; resolve: (value: ChooseResult) => void };

const DialogContext = createContext<DialogApi | null>(null);

const InfoIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
    <path d="M12 11v5M12 7.5v.5" />
  </svg>
);

const WarnIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
    <path d="M12 8v5M12 16.5v.5" />
  </svg>
);

export const DialogProvider = ({ children }: { children: ReactNode }) => {
  const [pending, setPending] = useState<Pending | null>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  const choose = useCallback(
    (options: ConfirmOptions & { alternateLabel?: string }) =>
      new Promise<ChooseResult>((resolve) => {
        // 이미 열린 다이얼로그가 있으면 그것은 취소로 닫고 새 것을 띄운다
        setPending((previous) => {
          previous?.resolve('cancel');
          return { options, resolve };
        });
      }),
    [],
  );

  const confirm = useCallback((options: ConfirmOptions) => choose(options).then((result) => result === 'confirm'), [choose]);

  const settle = useCallback((value: ChooseResult) => {
    setPending((previous) => {
      previous?.resolve(value);
      return null;
    });
  }, []);

  // Esc = 취소, Enter = 기본 동작. 열리면 기본 동작 버튼에 포커스
  useEffect(() => {
    if (!pending) return;
    const cancelFirst = pending.options.defaultAction === 'cancel';
    (cancelFirst ? cancelRef : confirmRef).current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        settle('cancel');
      } else if (event.key === 'Enter') {
        event.preventDefault();
        settle(cancelFirst ? 'cancel' : 'confirm');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pending, settle]);

  const api = useMemo<DialogApi>(() => ({ confirm, choose }), [confirm, choose]);
  const options = pending?.options;
  const danger = options?.kind === 'danger';

  return (
    <DialogContext.Provider value={api}>
      {children}
      {options ? (
        <div className={styles.overlay} onMouseDown={() => settle('cancel')}>
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="app-dialog-title"
            className={styles.dialog}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className={styles.row}>
              <span className={danger ? styles.iconDanger : styles.icon}>{danger ? <WarnIcon /> : <InfoIcon />}</span>
              <div className={styles.text}>
                <span id="app-dialog-title" className={styles.title}>
                  {options.title}
                </span>
                {options.description ? <span className={styles.description}>{options.description}</span> : null}
                {options.warning ? <strong className={styles.warning}>{options.warning}</strong> : null}
              </div>
            </div>
            <div className={styles.actions}>
              <button ref={cancelRef} type="button" className={styles.cancel} onClick={() => settle('cancel')}>
                {options.cancelLabel ?? '취소'}
              </button>
              {options.alternateLabel ? (
                <button type="button" className={styles.cancel} onClick={() => settle('alternate')}>
                  {options.alternateLabel}
                </button>
              ) : null}
              <button
                ref={confirmRef}
                type="button"
                className={danger ? styles.confirmDanger : styles.confirm}
                onClick={() => settle('confirm')}
              >
                {options.confirmLabel ?? '확인'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </DialogContext.Provider>
  );
};

export const useDialog = (): DialogApi => {
  const api = useContext(DialogContext);
  if (!api) throw new Error('useDialog 는 DialogProvider 안에서만 쓸 수 있습니다');
  return api;
};