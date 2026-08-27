/** 컨테이너 헬스체크 — 인증·모델과 무관하게 서버가 살아 있으면 200 */
export const GET = (): Response => new Response('ok', { headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } });