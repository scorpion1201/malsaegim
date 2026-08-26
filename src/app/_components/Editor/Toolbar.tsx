'use client';

import { useEditorState, type Editor } from '@tiptap/react';
import styles from './Editor.module.css';

type ToolbarProps = {
  editor: Editor;
  showTimestamps: boolean;
  onToggleTimestamps: () => void;
};

export const Toolbar = ({ editor, showTimestamps, onToggleTimestamps }: ToolbarProps) => {
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
          }),
       });

  const button = (label: string, active: boolean, run: () => void, title: string) => (
      <button
       type="button"
       className={active ? styles.toolActive : styles.tool}
       onMouseDown={(event) => event.preventDefault()}
       onClick={run}
       disabled={!state.editable}
       title={title}
      >
        {label}
      </button>
    );

  const chain = () => editor.chain().focus();

  return (
      <div className={styles.toolbar} role="toolbar" aria-label="서식">
        {button('H1', state.h1, () => chain().toggleHeading({ level: 1 }).run(), '제목 1')}
        {button('H2', state.h2, () => chain().toggleHeading({ level: 2 }).run(), '제목 2')}
        {button('H3', state.h3, () => chain().toggleHeading({ level: 3 }).run(), '제목 3')}
        <span className={styles.separator} />
        {button('B', state.bold, () => chain().toggleBold().run(), '굵게 (Ctrl+B)')}
        {button('I', state.italic, () => chain().toggleItalic().run(), '기울임 (Ctrl+I)')}
        {button('U', state.underline, () => chain().toggleUnderline().run(), '밑줄 (Ctrl+U)')}
        <span className={styles.separator} />
        {button('•', state.bullet, () => chain().toggleBulletList().run(), '글머리 기호')}
        {button('1.', state.ordered, () => chain().toggleOrderedList().run(), '번호 목록')}
        <span className={styles.separator} />
        <button
         type="button"
         className={showTimestamps ? styles.toolActive : styles.tool}
         onClick={onToggleTimestamps}
         title="타임스탬프 표시/숨김"
        >
          ⏱
        </button>
      </div>
    );
};