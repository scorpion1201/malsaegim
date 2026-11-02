'use client';

import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useEffect, useMemo, useRef } from 'react';
import type { TiptapDoc } from '@/app/_lib/hwp/tiptapToDocModel';
import { formatTimestamp } from '@/app/_lib/time';
import styles from './Editor.module.css';
import { FailedChunkNode, RETRY_EVENT, type RetryEventDetail } from './FailedChunkNode';
import { SpeakerNode } from './SpeakerNode';
import { SEEK_EVENT, TimestampNode, type SeekEventDetail } from './TimestampNode';
import { Toolbar } from './Toolbar';
import { TranscriptRole } from './TranscriptRole';

export type EditorProps = {
  value: TiptapDoc | null;
  editable: boolean;
  showTimestamps: boolean;
  currentMs: number;
  statusLabel: string;
  onChange: (doc: TiptapDoc) => void;
  onSeek: (ms: number) => void;
  onRetryChunk: (startMs: number, endMs: number) => void;
  onToggleTimestamps: () => void;
  /** 녹음 중: 본문 아래에 "다음 조각 시작 시각 + 상태" 줄을 깜박이는 커서와 함께 보여준다 */
  live?: { startMs: number; label: string; partial?: string } | null;
  layoutOpen: boolean;
  layoutDisabled: boolean;
  onToggleLayout: () => void;
  showSource?: boolean;
  /** 번역 노트만 준다. null 이면 원문 숨기기 버튼이 없다 */
  onToggleSource?: (() => void) | null;
  noteLabel?: string;
};

export const Editor = ({
  value,
  editable,
  showTimestamps,
  currentMs,
  statusLabel,
  onChange,
  onSeek,
  onRetryChunk,
  onToggleTimestamps,
  live = null,
  layoutOpen,
  layoutDisabled,
  onToggleLayout,
  showSource = true,
  onToggleSource = null,
  noteLabel,
}: EditorProps) => {
  const rootRef = useRef<HTMLDivElement>(null);

  // 확장 목록은 한 번만 만든다 — 매 렌더마다 새 배열이면 useEditor 가 setOptions 를 반복한다.
  // 노드뷰의 클릭은 DOM 이벤트로 올라오고 아래 effect 가 현재 콜백으로 받는다.
  const extensions = useMemo(
    () => [
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
      TimestampNode,
      SpeakerNode,
      FailedChunkNode,
      TranscriptRole,
    ],
    [],
  );

  const editor = useEditor({
    immediatelyRender: false,
    editable,
    extensions,
    content: value ?? undefined,
    onUpdate: ({ editor: e }) => onChange(e.getJSON() as TiptapDoc),
  });

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onSeekEvent = (event: Event) => onSeek((event as CustomEvent<SeekEventDetail>).detail.ms);
    const onRetryEvent = (event: Event) => {
      const { startMs, endMs } = (event as CustomEvent<RetryEventDetail>).detail;
      onRetryChunk(startMs, endMs);
    };
    root.addEventListener(SEEK_EVENT, onSeekEvent);
    root.addEventListener(RETRY_EVENT, onRetryEvent);
    return () => {
      root.removeEventListener(SEEK_EVENT, onSeekEvent);
      root.removeEventListener(RETRY_EVENT, onRetryEvent);
    };
  }, [onSeek, onRetryChunk, editor]);

  useEffect(() => {
    // emitUpdate=false: 기본값이면 setContent 효과보다 먼저 update 이벤트가 나가 이전 내용이 onChange 로 덮어쓴다
    editor?.setEditable(editable, false);
  }, [editor, editable]);

  useEffect(() => {
    if (!editor || !value) return;
    // Tiptap 노드뷰는 setContent 중 flushSync 를 부르므로 React 커밋 밖(매크로태스크)에서 실행한다
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
    <div
      ref={rootRef}
      className={`${styles.editor}${showTimestamps ? '' : ` ${styles.hideTimestamps}`}${showSource ? '' : ` ${styles.hideSource}`}`}
    >
      <Toolbar
        editor={editor}
        showTimestamps={showTimestamps}
        onToggleTimestamps={onToggleTimestamps}
        statusLabel={statusLabel}
        layoutOpen={layoutOpen}
        layoutDisabled={layoutDisabled}
        onToggleLayout={onToggleLayout}
        showSource={showSource}
        onToggleSource={onToggleSource}
        noteLabel={noteLabel}
      />
      <div className={styles.divider} />
      <div className={styles.scroll}>
        <EditorContent editor={editor} className={styles.content} />
        {live ? (
          <p className={styles.liveRow} aria-live="polite">
            <span className={styles.liveChip}>{formatTimestamp(live.startMs)}</span>
            <span className={live.partial ? styles.livePartial : styles.liveText}>
              {live.partial || live.label}
              <span className={styles.caret} />
            </span>
          </p>
        ) : null}
      </div>
    </div>
  );
};