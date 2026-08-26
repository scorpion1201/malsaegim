import { request as httpsRequest } from 'node:https';
import { BlockedTargetError, isAllowedHost, parseProxyTarget, publicOnlyLookup } from '@/app/_lib/asr/proxyTarget';

/**
 * BYOK pass-through — 브라우저가 API 를 직접 부르면 CORS 에 막히므로, 요청을 그대로 대상 주소로 넘긴다.
 * 서버는 키·주소·모델을 갖지 않고, 오디오·응답·키를 저장하거나 기록하지 않는다.
 * 대상은 x-asr-target-url 헤더로 오고, authorization 등 필요한 헤더만 골라 전달한다.
 * 공개 https 주소만 허용하고, 리다이렉트는 따라가지 않는다.
 */
export const runtime = 'nodejs';

const MAX_BODY_BYTES = 12 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const BODY_TIMEOUT_MS = 60_000;
const UPSTREAM_TIMEOUT_MS = 120_000;
/** 프로세스가 동시에 들고 있을 요청 — 본문과 응답이 메모리에 올라가므로 건당 최대 20MB, 합쳐 약 480MB 다 */
const MAX_ACTIVE_REQUESTS = 24;
const FORWARD_HEADERS = ['authorization', 'content-type'];

let activeRequests = 0;

class BodyTooLargeError extends Error {}
class BodyTimeoutError extends Error {}
class RedirectError extends Error {}

type Upstream = { status: number; contentType: string; payload: Buffer };

const badRequest = (error: string) => Response.json({ error }, { status: 400 });

/** 읽는 도중에 크기를 재서 상한을 넘는 본문을 메모리에 쌓지 않는다 */
const readBody = async (request: Request): Promise<Buffer> => {
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) throw new BodyTooLargeError();
  const reader = request.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    void reader.cancel();
  }, BODY_TIMEOUT_MS);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (expired) throw new BodyTimeoutError();
      if (done) return Buffer.concat(chunks);
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new BodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    clearTimeout(timer);
  }
};

/** fetch 대신 https 를 쓴다 — 연결 주소를 검사하는 lookup 을 끼우고, 리다이렉트를 따라가지 않기 위해서다 */
const forward = (target: URL, headers: Record<string, string>, body: Buffer): Promise<Upstream> =>
  new Promise((resolve, reject) => {
    const upstream = httpsRequest(
      target,
      {
        method: 'POST',
        headers: { ...headers, 'content-length': String(body.byteLength) },
        lookup: publicOnlyLookup,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      },
      (response) => {
        const status = response.statusCode ?? 502;
        if (status >= 300 && status < 400) {
          upstream.destroy(new RedirectError());
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > MAX_RESPONSE_BYTES) upstream.destroy(new Error('응답이 너무 큽니다'));
          else chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () =>
          resolve({
            status,
            contentType: response.headers['content-type'] ?? 'application/json',
            payload: Buffer.concat(chunks),
          }),
        );
      },
    );
    upstream.on('error', reject);
    upstream.end(body);
  });

export const POST = async (request: Request): Promise<Response> => {
  // 같은 페이지에서 온 요청만 — 외부 사이트가 이 서버를 중계기로 쓰지 못하게
  if (request.headers.get('sec-fetch-site') !== 'same-origin') {
    return Response.json({ error: '앱 안에서만 쓸 수 있습니다' }, { status: 403 });
  }
  const target = parseProxyTarget(request.headers.get('x-asr-target-url'));
  if (!target) return badRequest('x-asr-target-url 은 공개 https 주소여야 합니다');
  if (!isAllowedHost(target.hostname)) return Response.json({ error: '허용되지 않은 API 주소입니다' }, { status: 403 });
  if (!request.headers.get('authorization')) return badRequest('authorization 헤더가 없습니다');
  if (activeRequests >= MAX_ACTIVE_REQUESTS) {
    return Response.json({ error: '요청이 많습니다. 잠시 후 다시 시도하세요' }, { status: 429 });
  }

  activeRequests += 1;
  try {
    const body = await readBody(request);
    const headers: Record<string, string> = {};
    for (const name of FORWARD_HEADERS) {
      const value = request.headers.get(name);
      if (value) headers[name] = value;
    }
    const { status, contentType, payload } = await forward(target, headers, body);
    return new Response(new Uint8Array(payload), { status, headers: { 'content-type': contentType } });
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return Response.json({ error: `본문이 ${MAX_BODY_BYTES} 바이트를 넘습니다` }, { status: 413 });
    }
    if (error instanceof BodyTimeoutError) return Response.json({ error: '본문 수신 시간이 초과됐습니다' }, { status: 408 });
    if (error instanceof BlockedTargetError) return badRequest('x-asr-target-url 은 공개 https 주소여야 합니다');
    if (error instanceof RedirectError) return Response.json({ error: '대상 API 가 다른 주소로 보냈습니다' }, { status: 502 });
    // 내부 연결 정보가 새지 않도록 원인은 돌려주지 않는다
    return Response.json({ error: '대상 API 에 연결하지 못했습니다' }, { status: 502 });
  } finally {
    activeRequests -= 1;
  }
};