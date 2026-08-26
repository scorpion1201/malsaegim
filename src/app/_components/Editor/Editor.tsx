'use client';

import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useEffect, useRef } from 'react';
import type { TiptapDoc } from '@/app/_lib/hwp/tiptapToDocModel';
import styles from './Editor.module.css';
import { TimestampNode } from './TimestampNode';
import { Toolbar } from './Toolbar';

export type EditorProps = {
  value: TiptapDoc | null;
  editable: boolean;
  showTimestamps: boolean;
  currentMs: number;
  onChange: (doc: TiptapDoc) => void;
  onSeek: (ms: number) => void;
  onToggleTimestamps: () => void;
};

export const Editor = ({
  value,
  editable,
  showTimestamps,
  currentMs,
  onChange,
  onSeek,
  onToggleTimestamps,
}: EditorProps) => {
  const rootRef = useRef<HTMLDivElement>(null);

  const editor = useEditor({
    immediatelyRender: false,
    editable,
    extensions: [
       StarterKit.configure({
         heading: { levels: [1, 2, 3] },
         blockquote: false,
         code: false,
         codeBlock: false,
         horizontalRule: false,
         strike: false,
         link: false,
         dropcursor: false,
         gapcursor: false,
            }),
       TimestampNode.configure({ onSeek }),
        ],
    content: value ?? undefined,
    onUpdate: ({ editor: e }) => onChange(e.getJSON() as TiptapDoc),
       });

  useEffect(() => {
    // emitUpdate=false: 기본값(true)이면 이 효과가 setContent 효과보다 먼저 update 이벤트를 내보내
    // 아직 갱신되지 않은 이전 내용이 onChange 로 currentDoc 을 덮어쓴다 (마지막 문단 누락 버그).
    editor?.setEditable(editable, false);
     }, [editor, editable]);

  useEffect(() => {
    if (!editor || !value) return;
    // Tiptap 의 ReactNodeViewRenderer 는 setContent 중 flushSync 를 호출한다. React 는 자신의 렌더·
    // 패시브 효과 플러시도 마이크로태스크로 스케줄하므로 queueMicrotask 로는 충돌을 피할 수 없다
    // (실측: 오류 지속). 매크로태스크(setTimeout 0)로 미루면 커밋이 완전히 끝난 뒤 실행된다.
    const timer = setTimeout(() => {
      if (!editor.isDestroyed) editor.commands.setContent(value, { emitUpdate: false });
    }, 0);
    return () => clearTimeout(timer);
     }, [editor, value]);

     // 현재 재생 위치가 속한 조각(= ms 가 currentMs 이하인 것 중 최대)의 타임스탬프를 강조한다
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('button[data-ms]'));
    let active: HTMLButtonElement | null = null;
    for (const button of buttons) {
      const ms = Number(button.dataset.ms);
      if (ms <= currentMs && (!active || ms > Number(active.dataset.ms))) active = button;
         }
    buttons.forEach((button) => button.classList.toggle(styles.timestampActive, button === active));
     }, [currentMs, value]);

  if (!editor) return <div className={styles.placeholder}>에디터 준비 중…</div>;

  return (
      <div ref={rootRef} className={showTimestamps ? styles.editor : `${styles.editor} ${styles.hideTimestamps}`}>
        <Toolbar editor={editor} showTimestamps={showTimestamps} onToggleTimestamps={onToggleTimestamps} />
        <EditorContent editor={editor} className={styles.content} />
      </div>
    );
};