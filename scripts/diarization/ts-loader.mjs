// 앱의 순수 TS(src/app/_lib)를 node 에서 부르기 위한 resolve 훅 — `@/` 를 src/ 로, 확장자 없는 상대 경로를 .ts 로 푼다.
// 사용: node --import ./scripts/diarization/ts-loader.mjs <script>
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC = resolvePath(dirname(fileURLToPath(import.meta.url)), '../../src');

const candidate = (base) => [`${base}.ts`, `${base}/index.ts`, base].find((path) => path.endsWith('.ts') && existsSync(path));

/** 앱 TS 는 ES 모듈이다 — 형식을 알려 package.json 의 type 추측을 건너뛴다 */
const typescript = (path) => ({ url: pathToFileURL(path).href, format: 'module-typescript', shortCircuit: true });

registerHooks({
  resolve: (specifier, context, next) => {
    if (specifier.startsWith('@/')) {
      const path = candidate(resolvePath(SRC, specifier.slice(2)));
      if (path) return typescript(path);
    }
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      const parent = context.parentURL ? dirname(fileURLToPath(context.parentURL)) : process.cwd();
      const path = candidate(resolvePath(parent, specifier.replace(/\.ts$/, '')));
      if (path) return typescript(path);
    }
    return next(specifier, context);
  },
});