import { NextResponse, type NextRequest } from 'next/server';
import { readAuthConfig } from '@/app/_lib/auth/config';
import { SESSION_COOKIE, verifySessionToken } from '@/app/_lib/auth/session';

export const proxy = (request: NextRequest) => {
  // 헬스체크는 로그인과 무관하게 항상 연다
  if (request.nextUrl.pathname === '/healthz') return NextResponse.next();
  const auth = readAuthConfig();
  const isLogin = request.nextUrl.pathname === '/login';

  // 공유 비밀번호가 설정되지 않았으면 로그인 페이지 자체를 노출하지 않고 모든 경로를 연다
  if (!auth.enabled) {
    return isLogin ? NextResponse.redirect(new URL('/', request.url)) : NextResponse.next();
  }

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const authenticated = verifySessionToken(token, auth.secret);
  if (isLogin) {
    // 이미 로그인돼 있으면 로그인 페이지 대신 앱으로
    return authenticated ? NextResponse.redirect(new URL('/', request.url)) : NextResponse.next();
  }
  if (authenticated) return NextResponse.next();

  if (request.nextUrl.pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  return NextResponse.redirect(new URL('/login', request.url));
};

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};