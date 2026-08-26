import 'server-only';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { HwpDocument, initSync } from '@rhwp/core';

export type RhwpEngine = {
  createDocument: () => HwpDocument;
  parse: (bytes: Uint8Array) => HwpDocument;
};

// 기본 경로는 정적으로 두어 Turbopack이 node_modules/@rhwp/core 만 트레이싱하게 한다.
// RHWP_WASM_PATH 로 덮어쓰는 분기는 동적이라 트레이싱에서 제외한다 — 제외하지 않으면
// 프로젝트 루트 전체(.env 포함)가 standalone 산출물에 딸려 들어간다.
const readWasm = (): Promise<Buffer> => {
  const override = process.env.RHWP_WASM_PATH;
  if (override) return readFile(/* turbopackIgnore: true */ override);
  return readFile(path.join(process.cwd(), 'node_modules', '@rhwp', 'core', 'rhwp_bg.wasm'));
};

let enginePromise: Promise<RhwpEngine> | null = null;

export const loadRhwpEngine = (): Promise<RhwpEngine> => {
  if (!enginePromise) {
    enginePromise = readWasm().then((bytes) => {
      initSync({ module: bytes });
      return {
        createDocument: () => HwpDocument.createEmpty(),
        parse: (data) => new HwpDocument(data),
      };
    });
  }
  return enginePromise;
};