'use client';

import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react';
import { formatTimestamp } from '@/app/_lib/time';
import styles from './Editor.module.css';

/** 새로고침 클릭 → 에디터 루트로 버블링되는 이벤트. Editor 가 받아 그 조각만 재인식을 요청한다. */
export const RETRY_EVENT = 'asr:retry';
export type RetryEventDetail = { startMs: number; endMs: number };

const label = (startMs: number, endMs: number) =>
  `인식 실패 ${formatTimestamp(startMs)}–${formatTimestamp(endMs)}`;

const FailedChunkView = ({ node }: ReactNodeViewProps) => {
  const startMs = Number(node.attrs.startMs ?? 0);
  const endMs = Number(node.attrs.endMs ?? 0);
  // 이어 붙인 파트는 파트 안 시각으로 보인다 (재인식 요청은 노트 시간축 그대로)
  const offset = Number(node.attrs.offset ?? 0);
  return (
    <NodeViewWrapper as="span" className={styles.failedWrapper}>
      <span className={styles.failedLabel} contentEditable={false}>
        {label(startMs - offset, endMs - offset)}
      </span>
      <button
        type="button"
        className={styles.failedRetry}
        contentEditable={false}
        aria-label="이 조각만 다시 인식"
        data-tooltip="이 조각만 다시 인식"
        onClick={(event) => {
          event.currentTarget.dispatchEvent(
            new CustomEvent<RetryEventDetail>(RETRY_EVENT, { bubbles: true, detail: { startMs, endMs } }),
          );
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 12a9 9 0 1 1-2.6-6.4" />
          <path d="M21 4v5h-5" />
        </svg>
      </button>
    </NodeViewWrapper>
  );
};

/** 인식에 실패한 조각 자리 — 새로고침 버튼으로 그 조각만 다시 인식한다. 내보낼 때는 텍스트로 바뀐다. */
export const FailedChunkNode = Node.create({
  name: 'failedChunk',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      startMs: {
        default: 0,
        parseHTML: (element) => Number(element.getAttribute('data-start-ms') ?? 0),
        renderHTML: (attributes) => ({ 'data-start-ms': String(attributes.startMs) }),
      },
      endMs: {
        default: 0,
        parseHTML: (element) => Number(element.getAttribute('data-end-ms') ?? 0),
        renderHTML: (attributes) => ({ 'data-end-ms': String(attributes.endMs) }),
      },
      offset: {
        default: 0,
        parseHTML: (element) => Number(element.getAttribute('data-offset') ?? 0),
        renderHTML: (attributes) => (Number(attributes.offset) > 0 ? { 'data-offset': String(attributes.offset) } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-failed-chunk]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes({ 'data-failed-chunk': '' }, HTMLAttributes),
      label(
        Number(HTMLAttributes['data-start-ms'] ?? 0) - Number(HTMLAttributes['data-offset'] ?? 0),
        Number(HTMLAttributes['data-end-ms'] ?? 0) - Number(HTMLAttributes['data-offset'] ?? 0),
      ),
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(FailedChunkView);
  },
});