'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import styles from './Workspace.module.css';

type SidebarDrawerProps = {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
};

/** 767px 이하에서 사이드바를 왼쪽 서랍으로 띄운다. 그보다 넓으면 자식이 그대로 격자에 놓인다 */
export const SidebarDrawer = ({ open, onClose, children }: SidebarDrawerProps) => {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLElement>('button, a')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <div className={open ? styles.drawerOpen : styles.drawer}>
      <div className={styles.drawerScrim} onClick={onClose} />
      <div ref={panelRef} className={styles.drawerPanel}>
        {children}
      </div>
    </div>
  );
};