'use client';

import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react';
import { formatTimestamp } from '@/app/_lib/time';
import styles from './Editor.module.css';

export type TimestampOptions = {
  onSeek: (ms: number) => void;
};

const TimestampView = ({ node, extension }: ReactNodeViewProps) => {
  const ms = Number(node.attrs.ms ?? 0);
  const { onSeek } = extension.options as TimestampOptions;
  return (
      <NodeViewWrapper as="span" className={styles.timestampWrapper}>
          <button
           type="button"
           className={styles.timestamp}
           data-ms={ms}
           contentEditable={false}
           title="이 위치부터 재생"
           onClick={() => onSeek(ms)}
          >
            [{formatTimestamp(ms)}]
          </button>
      </NodeViewWrapper>
    );
};

export const TimestampNode = Node.create<TimestampOptions>({
  name: 'timestamp',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addOptions() {
    return { onSeek: () => {} };
     },

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
          `[${formatTimestamp(Number(HTMLAttributes['data-ms'] ?? 0))}]`,
         ];
       },

  addNodeView() {
    return ReactNodeViewRenderer(TimestampView);
     },
});