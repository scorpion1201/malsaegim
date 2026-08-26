import { createHash } from 'node:crypto';

export type AuthConfig = {
  /** APP_SHARED_PASSWORD 가 비어 있으면 로그인 없이 바로 쓴다 */
  enabled: boolean;
  password: string;
  /** 세션 쿠키 서명 키 — AUTH_COOKIE_SECRET 이 없으면 비밀번호에서 파생한다 */
  secret: string;
};

/**
 * 공유 비밀번호는 선택 사항이다. 비어 있으면 인증을 끄고, 있으면 쿠키 서명 키는
 * AUTH_COOKIE_SECRET 또는 (없을 때) 비밀번호의 SHA-256 파생값을 쓴다 — 비밀번호를 바꾸면
 * 기존 세션은 자연히 무효화된다.
 */
export const readAuthConfig = (env: NodeJS.ProcessEnv = process.env): AuthConfig => {
  const password = (env.APP_SHARED_PASSWORD ?? '').trim();
  if (password.length === 0) return { enabled: false, password: '', secret: '' };
  const explicit = (env.AUTH_COOKIE_SECRET ?? '').trim();
  const secret =
    explicit.length > 0 ? explicit : createHash('sha256').update(`malsaegim:${password}`).digest('hex');
  return { enabled: true, password, secret };
};