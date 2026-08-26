'use client';

import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react';
import { formatTimestamp } from '@/app/_lib/time';
import styles from './Editor.module.css';

/** 타임스탬프 클릭 → 에디터 루트로 버블링되는 이벤트. Editor 가 받아 플레이어를 이동시킨다. */
export const SEEK_EVENT = 'asr:seek';
export type SeekEventDetail = { ms: number };

const TimestampView = ({ node }: ReactNodeViewProps) => {
  const ms = Number(node.attrs.ms ?? 0);
  return (
    <NodeViewWrapper as="span" className={styles.timestampWrapper}>
      <button
        type="button"
        className={styles.timestamp}
        data-ms={ms}
        contentEditable={false}
        title="이 위치부터 재생"
        onClick={(event) => {
          event.currentTarget.dispatchEvent(
            new CustomEvent<SeekEventDetail>(SEEK_EVENT, { bubbles: true, detail: { ms } }),
          );
        }}
      >
        {formatTimestamp(ms)}
      </button>
    </NodeViewWrapper>
  );
};

export const TimestampNode = Node.create({
  name: 'timestamp',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      ms: {
        default: 0,
        parseHTML: (element) => Number(element.getAttribute('data-ms') ?? 0),
        renderHTML: (attributes) => ({ 'data-ms': String(attributes.ms) }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-timestamp]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes({ 'data-timestamp': '' }, HTMLAttributes),
      formatTimestamp(Number(HTMLAttributes['data-ms'] ?? 0)),
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(TimestampView);
  },
});