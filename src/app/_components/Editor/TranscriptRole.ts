import { Extension } from '@tiptap/core';

/** 번역 노트의 문단 구분. Enter 로 나눈 새 문단은 일반 문단이 되어 원문 숨기기에 숨지 않는다 */
export const TranscriptRole = Extension.create({
  name: 'transcriptRole',
  addGlobalAttributes: () => [
    {
      types: ['paragraph'],
      attributes: {
        role: {
          default: null,
          keepOnSplit: false,
          parseHTML: (element) => element.getAttribute('data-role'),
          renderHTML: (attributes) => (attributes.role ? { 'data-role': attributes.role } : {}),
        },
        lang: {
          default: null,
          keepOnSplit: false,
          parseHTML: (element) => element.getAttribute('lang'),
          renderHTML: (attributes) => (attributes.lang ? { lang: attributes.lang } : {}),
        },
      },
    },
  ],
});