export type ThemePreference = 'system' | 'light' | 'dark';

export const THEME_KEY = 'malsaegim:theme';

export const isThemePreference = (value: unknown): value is ThemePreference =>
  value === 'system' || value === 'light' || value === 'dark';

export const readThemePreference = (storage: Pick<Storage, 'getItem'>): ThemePreference => {
  try {
    const raw = storage.getItem(THEME_KEY);
    return isThemePreference(raw) ? raw : 'system';
  } catch {
    return 'system';
  }
};

/** html[data-theme] 를 맞춘다. system 이면 속성을 지워 prefers-color-scheme 가 결정하게 한다. */
export const applyThemePreference = (preference: ThemePreference): void => {
  const root = document.documentElement;
  if (preference === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', preference);
};

export const saveThemePreference = (
  storage: Pick<Storage, 'setItem' | 'removeItem'>,
  preference: ThemePreference,
): void => {
  try {
    if (preference === 'system') storage.removeItem(THEME_KEY);
    else storage.setItem(THEME_KEY, preference);
  } catch {
    // 저장 실패는 무시 — 이번 세션에는 적용된 상태
  }
};

/** 첫 페인트 전에 실행되는 인라인 스크립트 — 저장된 수동 테마가 있으면 깜빡임 없이 적용 */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem('${THEME_KEY}');if(t==='light'||t==='dark'){document.documentElement.setAttribute('data-theme',t);}}catch(e){}})();`;