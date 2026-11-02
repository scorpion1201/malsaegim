'use client';

import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react';
import { useState } from 'react';
import { speakerLabel } from '@/app/_lib/editor/blocksToTiptapDoc';
import styles from './Editor.module.css';

/** 화자 색 개수 — Editor.module.css 의 data-tone 과 맞춘다 */
const TONES = 5;
const MAX_NAME_LENGTH = 40;

const SpeakerView = ({ node, editor }: ReactNodeViewProps) => {
  const id = Number(node.attrs.id ?? 0);
  const name = typeof node.attrs.name === 'string' ? node.attrs.name : null;
  const label = speakerLabel(id, name);
  const [draft, setDraft] = useState<string | null>(null);

  // 이름은 한 사람의 표시이므로 노트 안의 같은 화자를 함께 바꾼다
  const rename = () => {
    const next = draft?.trim().slice(0, MAX_NAME_LENGTH) || null;
    setDraft(null);
    if (next === name) return;
    const { tr, doc } = editor.state;
    doc.descendants((child, position) => {
      if (child.type.name === 'speaker' && Number(child.attrs.id) === id) tr.setNodeMarkup(position, undefined, { ...child.attrs, name: next });
    });
    editor.view.dispatch(tr);
  };

  return (
    <NodeViewWrapper as="span" className={styles.speakerWrapper}>
      {draft === null ? (
        <button
          type="button"
          className={styles.speaker}
          data-tone={id % TONES}
          contentEditable={false}
          title="눌러서 이름 바꾸기"
          disabled={!editor.isEditable}
          onClick={() => setDraft(name ?? '')}
        >
          {label}
        </button>
      ) : (
        <input
          className={styles.speakerInput}
          contentEditable={false}
          value={draft}
          placeholder={speakerLabel(id, null)}
          maxLength={MAX_NAME_LENGTH}
          size={Math.max(6, draft.length + 1)}
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
          onBlur={rename}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Enter') {
              event.preventDefault();
              rename();
            } else if (event.key === 'Escape') {
              setDraft(null);
            }
          }}
        />
      )}
    </NodeViewWrapper>
  );
};

export const SpeakerNode = Node.create({
  name: 'speaker',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      id: {
        default: 0,
        parseHTML: (element) => Number(element.getAttribute('data-speaker') ?? 0),
        renderHTML: (attributes) => ({ 'data-speaker': String(attributes.id) }),
      },
      name: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-name'),
        renderHTML: (attributes) => (attributes.name ? { 'data-name': String(attributes.name) } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-speaker]' }];
  },

  renderHTML({ HTMLAttributes }) {
    const name = HTMLAttributes['data-name'];
    return ['span', mergeAttributes(HTMLAttributes), speakerLabel(Number(HTMLAttributes['data-speaker'] ?? 0), typeof name === 'string' ? name : null)];
  },

  addNodeView() {
    return ReactNodeViewRenderer(SpeakerView);
  },
});