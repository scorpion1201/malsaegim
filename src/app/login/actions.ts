'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  createSessionToken,
  passwordMatches,
} from '@/app/_lib/auth/session';

export const login = async (formData: FormData): Promise<void> => {
  const password = String(formData.get('password') ?? '');
  const expected = process.env.APP_SHARED_PASSWORD ?? '';
  const secret = process.env.AUTH_COOKIE_SECRET ?? '';
  if (!secret || !passwordMatches(password, expected)) {
    redirect('/login?error=1');
    }
  const store = await cookies();
  store.set({
    name: SESSION_COOKIE,
    value: createSessionToken(secret),
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
     });
  redirect('/');
};