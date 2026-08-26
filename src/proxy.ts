import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, verifySessionToken } from '@/app/_lib/auth/session';

export const proxy = (request: NextRequest) => {
  const secret = process.env.AUTH_COOKIE_SECRET ?? '';
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (secret.length > 0 && verifySessionToken(token, secret)) {
    return NextResponse.next();
    }
  if (request.nextUrl.pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  return NextResponse.redirect(new URL('/login', request.url));
};

export const config = {
  matcher: ['/((?!login|_next/static|_next/image|favicon.ico).*)'],
};