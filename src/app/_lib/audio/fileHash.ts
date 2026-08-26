/** 파일 바이트 전체의 SHA-256 (소문자 hex). 같은 오디오 재선택 판별용 — 조각 경계와 무관하게 결정적이다. */
export const sha256Hex = async (buffer: ArrayBuffer): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
};