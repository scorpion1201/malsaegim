'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { readAuthConfig } from '@/app/_lib/auth/config';
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  createSessionToken,
  passwordMatches,
} from '@/app/_lib/auth/session';

export const login = async (formData: FormData): Promise<void> => {
  const auth = readAuthConfig();
  if (!auth.enabled) redirect('/');

  const password = String(formData.get('password') ?? '');
  if (!passwordMatches(password, auth.password)) {
    redirect('/login?error=1');
  }
  const store = await cookies();
  store.set({
    name: SESSION_COOKIE,
    value: createSessionToken(auth.secret),
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
  redirect('/');
};