'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import styles from './Menu.module.css';

export type MenuItem =
  | {
      label: string;
      icon?: ReactNode;
      danger?: boolean;
      disabled?: boolean;
      onSelect: () => void;
    }
  | 'separator';

type MenuProps = {
  open: boolean;
  items: MenuItem[];
  /** 메뉴를 여는 요소 쪽 정렬 — 컨테이너는 position: relative 여야 한다 */
  align?: 'left' | 'right';
  label?: string;
  className?: string;
  onClose: () => void;
};

/**
 * 드롭다운 메뉴. 바깥 클릭·Escape 로 닫힌다.
 * 여는 버튼에는 data-menu-toggle 을 달아 두면 그 클릭은 "바깥"으로 치지 않아 토글이 두 번 실행되지 않는다.
 */
export const Menu = ({ open, items, align = 'left', label, className, onClose }: MenuProps) => {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (rootRef.current?.contains(target) || target.closest('[data-menu-toggle]')) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  const base = align === 'right' ? styles.menuRight : styles.menu;
  return (
    <div ref={rootRef} role="menu" aria-label={label} className={className ? `${base} ${className}` : base}>
      {items.map((item, index) =>
        item === 'separator' ? (
          <div key={`separator-${index}`} className={styles.separator} role="separator" />
        ) : (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            className={item.danger ? styles.itemDanger : styles.item}
            disabled={item.disabled}
            onClick={() => {
              item.onSelect();
              onClose();
            }}
          >
            {item.icon ? <span className={styles.icon}>{item.icon}</span> : null}
            <span>{item.label}</span>
          </button>
        ),
      )}
    </div>
  );
};