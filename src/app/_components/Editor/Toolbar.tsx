'use client';

import { useEditorState, type Editor } from '@tiptap/react';
import styles from './Editor.module.css';

type ToolbarProps = {
  editor: Editor;
  showTimestamps: boolean;
  onToggleTimestamps: () => void;
  statusLabel: string;
  /** 문서 레이아웃 패널 열림 상태 — 오른쪽 메타 영역의 용지 아이콘 */
  layoutOpen: boolean;
  layoutDisabled: boolean;
  onToggleLayout: () => void;
};

const BulletIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9 6h11M9 12h11M9 18h11" />
    <circle cx="4.5" cy="6" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="4.5" cy="12" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="4.5" cy="18" r="1.2" fill="currentColor" stroke="none" />
  </svg>
);

const OrderedIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M10 6h10M10 12h10M10 18h10" />
    <path d="M4 5.5h1.5v4M3.8 9.5h2.4" />
    <path d="M3.8 14.2c.4-.8 1.7-.9 2.1 0 .3.7-.4 1.2-1.9 2.6h2.4" />
  </svg>
);

const PageIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M7 3h7l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
    <path d="M14 3v5h5" />
    <path d="M9 13h6M9 17h6" />
  </svg>
);

const ClockIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
);

export const Toolbar = ({
  editor,
  showTimestamps,
  onToggleTimestamps,
  statusLabel,
  layoutOpen,
  layoutDisabled,
  onToggleLayout,
}: ToolbarProps) => {
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      h1: e.isActive('heading', { level: 1 }),
      h2: e.isActive('heading', { level: 2 }),
      h3: e.isActive('heading', { level: 3 }),
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      editable: e.isEditable,
      characters: e.state.doc.textContent.length,
    }),
  });

  const chain = () => editor.chain().focus();

  const button = (
    label: string,
    active: boolean,
    run: () => void,
    tooltip: string,
    shortcut?: string,
    extraClass?: string,
  ) => (
    <button
      type="button"
      className={`${active ? styles.toolActive : styles.tool}${extraClass ? ` ${extraClass}` : ''}`}
      onMouseDown={(event) => event.preventDefault()}
      onClick={run}
      disabled={!state.editable}
      aria-label={tooltip}
      aria-pressed={active}
      data-tooltip={tooltip}
      data-shortcut={shortcut}
    >
      {label}
    </button>
  );

  return (
    <div className={styles.toolbar} role="toolbar" aria-label="서식">
      <div className={styles.toolGroup}>
        {button('H1', state.h1, () => chain().toggleHeading({ level: 1 }).run(), '제목 1', '⌘⌥1')}
        {button('H2', state.h2, () => chain().toggleHeading({ level: 2 }).run(), '제목 2', '⌘⌥2')}
        {button('H3', state.h3, () => chain().toggleHeading({ level: 3 }).run(), '제목 3', '⌘⌥3')}
        <span className={styles.separator} />
        {button('B', state.bold, () => chain().toggleBold().run(), '굵게', '⌘B')}
        {button('I', state.italic, () => chain().toggleItalic().run(), '기울임', '⌘I', styles.toolItalic)}
        {button('U', state.underline, () => chain().toggleUnderline().run(), '밑줄', '⌘U', styles.toolUnderline)}
        <span className={styles.separator} />
        <button
          type="button"
          className={state.bullet ? styles.toolActive : styles.tool}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => chain().toggleBulletList().run()}
          disabled={!state.editable}
          aria-label="글머리 기호"
          aria-pressed={state.bullet}
          data-tooltip="글머리 기호"
          data-shortcut="⌘⇧8"
        >
          <BulletIcon />
        </button>
        <button
          type="button"
          className={state.ordered ? styles.toolActive : styles.tool}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => chain().toggleOrderedList().run()}
          disabled={!state.editable}
          aria-label="번호 목록"
          aria-pressed={state.ordered}
          data-tooltip="번호 목록"
          data-shortcut="⌘⇧7"
        >
          <OrderedIcon />
        </button>
        <span className={styles.separator} />
        <button
          type="button"
          className={showTimestamps ? styles.toolActive : styles.tool}
          onMouseDown={(event) => event.preventDefault()}
          onClick={onToggleTimestamps}
          aria-pressed={showTimestamps}
          data-tooltip={showTimestamps ? '타임스탬프 숨기기' : '타임스탬프 보이기'}
        >
          <ClockIcon />
          <span className={styles.toolLabel}>타임스탬프</span>
        </button>
      </div>
      <div className={styles.toolbarMeta}>
        <button
          type="button"
          className={layoutOpen ? styles.toolActive : styles.tool}
          onMouseDown={(event) => event.preventDefault()}
          onClick={onToggleLayout}
          disabled={layoutDisabled}
          aria-pressed={layoutOpen}
          aria-label="문서 레이아웃"
          data-tooltip="문서 레이아웃"
        >
          <PageIcon />
        </button>
        <span className={styles.separator} />
        <span>{state.characters.toLocaleString('ko-KR')}자</span>
        <span className={styles.separator} />
        <span>{statusLabel}</span>
      </div>
    </div>
  );
};