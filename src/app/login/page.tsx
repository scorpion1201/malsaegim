import { redirect } from 'next/navigation';
import { readAuthConfig } from '@/app/_lib/auth/config';
import { login } from './actions';
import styles from './login.module.css';

const LoginPage = async ({ searchParams }: PageProps<'/login'>) => {
  if (!readAuthConfig().enabled) redirect('/');
  const { error } = await searchParams;
  return (
     <main className={styles.main}>
        <form action={login} className={styles.form}>
          <h1 className={styles.title}>말새김</h1>
          <label className={styles.label} htmlFor="password">
           팀 비밀번호
          </label>
          <input
           id="password"
           name="password"
           type="password"
           autoComplete="current-password"
           required
           className={styles.input}
          />
          {error ? <p className={styles.error}>비밀번호가 맞지 않습니다.</p> : null}
          <button type="submit" className={styles.button}>
           들어가기
          </button>
        </form>
      </main>
    );
};

export default LoginPage;