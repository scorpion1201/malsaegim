import { createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'asr_session';
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

const sign = (issuedAt: string, secret: string): string =>
  createHmac('sha256', secret).update(issuedAt).digest('base64url');

const safeEqual = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

export const createSessionToken = (secret: string, now: number = Date.now()): string => {
  const issuedAt = String(now);
  return `${issuedAt}.${sign(issuedAt, secret)}`;
};

export const verifySessionToken = (
  token: string | undefined,
  secret: string,
  now: number = Date.now(),
): boolean => {
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot < 0) return false;
  const issuedAt = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  if (!/^\d+$/.test(issuedAt)) return false;
  if (!safeEqual(mac, sign(issuedAt, secret))) return false;
  const age = now - Number(issuedAt);
  return age >= 0 && age <= SESSION_MAX_AGE_SECONDS * 1000;
};

export const passwordMatches = (input: string, expected: string): boolean =>
   expected.length > 0 && safeEqual(input, expected);