'use client';

import { useState } from 'react';
import {
  BODY_FONTS,
  DEFAULT_PAGE_LAYOUT,
  PAPERS,
  PAPER_IDS,
  paperSizeMm,
  type PageLayout,
  type PageMargins,
  type PaperId,
} from '@/app/_lib/hwp/pageLayout';
import styles from './LayoutPanel.module.css';

export type LayoutPanelProps = {
  open: boolean;
  layout: PageLayout;
  onChange: (layout: PageLayout) => void;
  onClose: () => void;
};

const MARGIN_FIELDS: Array<{ key: keyof PageMargins; label: string }> = [
  { key: 'top', label: '위' },
  { key: 'bottom', label: '아래' },
  { key: 'left', label: '왼쪽' },
  { key: 'right', label: '오른쪽' },
  { key: 'header', label: '머리말' },
  { key: 'footer', label: '꼬리말' },
  { key: 'gutter', label: '제본' },
];

const PREVIEW_MAX_W = 124;
const PREVIEW_MAX_H = 175;
/** 미리보기 본문 안의 장식 줄 (오른쪽 여백을 조금씩 달리해 문단처럼 보이게) */
const PREVIEW_LINES = [0, 0, 24, 0, 0, 0, 12, 0, 0, 0, 0, 36, 0, 0, 0, 0, 0, 48];

const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n));

/**
 * 숫자 필드. 타이핑 중에는 입력한 문자열을 그대로 두고(그래야 "12" 를 칠 수 있다),
 * 범위 안의 숫자가 되는 순간 반영하며, 포커스를 잃을 때 범위로 정리한다.
 */
const NumberField = ({
  label,
  value,
  unit,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  unit: string;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) => {
  const [draft, setDraft] = useState(String(value));
  const [synced, setSynced] = useState(value);
  const [focused, setFocused] = useState(false);

  // 바깥(기본값으로, 다른 노트)에서 값이 바뀌면 편집 중이 아닐 때만 따라간다 — 렌더 중 상태 조정 패턴
  if (!focused && synced !== value) {
    setSynced(value);
    setDraft(String(value));
  }

  const commit = () => {
    const n = Number(draft);
    const next = draft.trim() === '' || !Number.isFinite(n) ? value : clamp(n, min, max);
    setDraft(String(next));
    setSynced(next);
    if (next !== value) onChange(next);
  };

  return (
    <label className={styles.field}>
      {label}
      <span className={styles.numberBox}>
        <input
          type="number"
          className={styles.number}
          value={draft}
          min={min}
          max={max}
          step={1}
          onFocus={() => setFocused(true)}
          onChange={(event) => {
            const raw = event.target.value;
            setDraft(raw);
            const n = Number(raw);
            if (raw.trim() !== '' && Number.isFinite(n) && n >= min && n <= max && n !== value) onChange(n);
          }}
          onBlur={() => {
            setFocused(false);
            commit();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
        />
        <span className={styles.unit}>{unit}</span>
      </span>
    </label>
  );
};

/** 문서 레이아웃 패널 — 에디터 오른쪽에서 슬라이드로 열리고, 값은 바꾸는 즉시 노트에 저장된다 */
export const LayoutPanel = ({ open, layout, onChange, onClose }: LayoutPanelProps) => {
  const size = paperSizeMm(layout);
  const scale = Math.min(PREVIEW_MAX_W / size.width, PREVIEW_MAX_H / size.height);
  const page = { width: size.width * scale, height: size.height * scale };
  const m = layout.margins;
  const inset = { left: m.left * scale, right: m.right * scale, top: m.top * scale, bottom: m.bottom * scale };
  const lineHeight = 8;
  const lineCount = Math.max(0, Math.min(PREVIEW_LINES.length, Math.floor((page.height - inset.top - inset.bottom - 4) / lineHeight)));

  const setMargin = (key: keyof PageMargins, value: number) =>
    onChange({ ...layout, margins: { ...layout.margins, [key]: value } });

  return (
    <aside className={open ? styles.panelOpen : styles.panel} aria-label="문서 레이아웃" aria-hidden={!open}>
      <div className={styles.inner}>
        <div className={styles.header}>
          <span className={styles.title}>문서 레이아웃</span>
          <button type="button" className={styles.close} onClick={onClose} aria-label="닫기" tabIndex={open ? 0 : -1}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <div className={styles.body}>
          <div className={styles.previewWrap}>
            <div className={styles.page} style={{ width: page.width, height: page.height }}>
              <div
                className={styles.pageBody}
                style={{ left: inset.left, right: inset.right, top: inset.top, bottom: inset.bottom }}
              />
              <div className={styles.pageRule} style={{ left: inset.left, right: inset.right, top: m.header * scale }} />
              <div className={styles.pageRule} style={{ left: inset.left, right: inset.right, bottom: m.footer * scale }} />
              {PREVIEW_LINES.slice(0, lineCount).map((shorten, index) => (
                <div
                  key={index}
                  className={styles.pageLine}
                  style={{
                    left: inset.left + 4,
                    right: inset.right + 4 + shorten * scale * 0.6,
                    top: inset.top + 4 + index * lineHeight,
                  }}
                />
              ))}
            </div>
            <span className={styles.caption}>
              {PAPERS[layout.paper].label} · {layout.orientation === 'landscape' ? '가로' : '세로'} · {size.width} × {size.height} mm
            </span>
          </div>

          <label className={styles.field}>
            용지 종류
            <select
              className={styles.select}
              value={layout.paper}
              onChange={(event) => onChange({ ...layout, paper: event.target.value as PaperId })}
            >
              {PAPER_IDS.map((id) => (
                <option key={id} value={id}>
                  {PAPERS[id].label} ({PAPERS[id].width} × {PAPERS[id].height} mm)
                </option>
              ))}
            </select>
          </label>

          <div className={styles.field}>
            용지 방향
            <div className={styles.segmented} role="group" aria-label="용지 방향">
              <button
                type="button"
                className={styles.segment}
                aria-pressed={layout.orientation === 'portrait'}
                onClick={() => onChange({ ...layout, orientation: 'portrait' })}
              >
                세로
              </button>
              <button
                type="button"
                className={styles.segment}
                aria-pressed={layout.orientation === 'landscape'}
                onClick={() => onChange({ ...layout, orientation: 'landscape' })}
              >
                가로
              </button>
            </div>
          </div>

          <div className={styles.section}>
            <div className={styles.sectionHead}>
              <span className={styles.sectionTitle}>여백</span>
              <button
                type="button"
                className={styles.reset}
                onClick={() => onChange({ ...layout, margins: { ...DEFAULT_PAGE_LAYOUT.margins } })}
              >
                기본값으로
              </button>
            </div>
            <div className={styles.grid}>
              {MARGIN_FIELDS.map((field) => (
                <NumberField
                  key={field.key}
                  label={field.label}
                  value={layout.margins[field.key]}
                  unit="mm"
                  min={0}
                  max={100}
                  onChange={(value) => setMargin(field.key, value)}
                />
              ))}
            </div>
          </div>

          <div className={styles.section}>
            <span className={styles.sectionTitle}>글꼴</span>
            <label className={styles.field}>
              본문 글꼴
              <select
                className={styles.select}
                value={layout.bodyFont}
                onChange={(event) => onChange({ ...layout, bodyFont: event.target.value })}
              >
                {(BODY_FONTS.includes(layout.bodyFont) ? BODY_FONTS : [layout.bodyFont, ...BODY_FONTS]).map((font) => (
                  <option key={font} value={font}>
                    {font}
                  </option>
                ))}
              </select>
            </label>
            <div className={styles.grid}>
              <NumberField label="본문 크기" value={layout.bodyPt} unit="pt" min={1} max={72} onChange={(bodyPt) => onChange({ ...layout, bodyPt })} />
              <NumberField label="제목 크기" value={layout.titlePt} unit="pt" min={1} max={96} onChange={(titlePt) => onChange({ ...layout, titlePt })} />
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
};