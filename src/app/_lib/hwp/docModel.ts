export type Run = {
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
};

export type HeadingLevel = 1 | 2 | 3;

export type Block =
    | { kind: 'heading'; level: HeadingLevel; runs: Run[] }
    | { kind: 'paragraph'; runs: Run[] }
    | { kind: 'listItem'; ordered: boolean; index: number; runs: Run[] };

export type DocModel = {
  title: string;
  blocks: Block[];
};

export type ExportFormat = 'hwp' | 'hwpx';

export class DocModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocModelError';
      }
}