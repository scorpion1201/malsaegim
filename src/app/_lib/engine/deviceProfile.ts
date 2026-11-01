/**
 * 기기 종류와 On-Device 기본 모델. 브라우저는 RAM 용량을 정확히 알려 주지 않으므로 여러 신호를 함께 본다.
 *  - PC: Turbo
 *  - iPad: Turbo (iPad Pro M1 처럼 RAM 이 넉넉한 기종이 많다. 칩·RAM 은 웹에서 알 수 없어 로딩 실패 시 small 로 바꾸도록 안내)
 *  - 휴대폰·태블릿(Android 등): navigator.deviceMemory 가 8 이상이면 Turbo, 낮거나 알 수 없으면(iPhone 포함) small
 * 사용자는 설정에서 언제든 바꿀 수 있다 (modelChoice).
 */
import type { ModelManifest, ModelTier, WhisperModel } from './modelStore';

export type DeviceKind = 'desktop' | 'ipad' | 'mobile';
export type DeviceProfile = {
  kind: DeviceKind;
  /** navigator.deviceMemory (GB, Chromium 계열만, 최대 8 로 잘린다). 모르면 null */
  memoryGb: number | null;
  /** 판정 근거 — 디버그·설정 안내용 */
  signals: string[];
};

/** Turbo 를 기본으로 줄 최소 deviceMemory (휴대폰·태블릿) */
const TURBO_MIN_MEMORY_GB = 8;
/** iPad 화면의 짧은 변(CSS px) 최솟값 — iPad mini 744, iPhone 은 가장 큰 모델도 440 */
const IPAD_MIN_SHORT_SIDE = 700;

type NavigatorExtras = Navigator & {
  deviceMemory?: number;
  standalone?: boolean;
  userAgentData?: { mobile?: boolean; platform?: string };
};

type MotionEventCtor = { requestPermission?: () => Promise<string> };

export const detectDeviceProfile = (): DeviceProfile => {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return { kind: 'desktop', memoryGb: null, signals: ['ssr'] };
  const nav = navigator as NavigatorExtras;
  const ua = nav.userAgent;
  const memoryGb = typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null;
  const touchPoints = nav.maxTouchPoints ?? 0;
  const shortSide = Math.min(window.screen.width, window.screen.height);
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  const noHover = window.matchMedia?.('(hover: none)').matches ?? false;
  const motion = (typeof DeviceMotionEvent === 'undefined' ? undefined : DeviceMotionEvent) as MotionEventCtor | undefined;
  // iOS·iPadOS WebKit 에만 있는 API 들 (macOS Safari 에는 없다)
  const iosApi = typeof motion?.requestPermission === 'function';
  const touchEvents = 'ontouchend' in document;
  const signals: string[] = [];

  // iPadOS 13+ Safari 는 기본으로 Mac UA 를 보낸다 — UA 만으로는 구분할 수 없어 Apple 플랫폼 + 터치 + iOS 전용 API + 화면 크기를 함께 본다
  const appleUa = /Macintosh|iPad|iPhone|iPod/.test(ua);
  const applePlatform = /^(MacIntel|iPad|iPhone|iPod)$/.test(nav.platform ?? '');
  const appleTouch = (appleUa || applePlatform) && touchPoints > 1;
  if (appleTouch) signals.push('apple-touch');
  if (iosApi) signals.push('ios-api');
  if (touchEvents) signals.push('touch-events');
  if (coarse) signals.push('coarse-pointer');
  if (noHover) signals.push('no-hover');
  // 데스크톱 Mac 은 터치 포인트가 0 이다. 터치 Apple 기기 + iOS 전용 신호 중 둘 이상이면 iOS 계열로 본다
  const iosEvidence = [iosApi, touchEvents, coarse, typeof nav.standalone === 'boolean'].filter(Boolean).length;
  const ios = /iPad|iPhone|iPod/.test(ua) || (appleTouch && iosEvidence >= 2);
  if (ios) {
    const tablet = /iPad/.test(ua) || (!/iPhone|iPod/.test(ua) && shortSide >= IPAD_MIN_SHORT_SIDE);
    signals.push(`short-side-${shortSide}`);
    return { kind: tablet ? 'ipad' : 'mobile', memoryGb, signals };
  }

  const uaMobile = nav.userAgentData?.mobile === true || /Android|Mobi|Opera Mini|IEMobile/i.test(ua);
  if (uaMobile) signals.push('mobile-ua');
  // UA 를 데스크톱으로 바꾼 휴대폰도 잡는다: 거친 포인터 + 호버 없음 + 작은 화면
  const touchOnly = coarse && noHover && touchPoints > 0 && shortSide < IPAD_MIN_SHORT_SIDE;
  if (touchOnly) signals.push('touch-only-small');
  const android = /Android/i.test(ua) || nav.userAgentData?.platform === 'Android';
  if (android) signals.push('android');
  return { kind: uaMobile || touchOnly || android ? 'mobile' : 'desktop', memoryGb, signals };
};

/** 이 기기에 기본으로 줄 모델 등급 */
export const defaultTier = (profile: DeviceProfile): ModelTier => {
  if (profile.kind !== 'mobile') return 'full';
  return profile.memoryGb !== null && profile.memoryGb >= TURBO_MIN_MEMORY_GB ? 'full' : 'lite';
};

/** 사용자가 고른 모델(id) 또는 자동 */
export type ModelChoice = 'auto' | string;
const CHOICE_KEY = 'malsaegim:ondevice-model';

export const readModelChoice = (): ModelChoice => {
  try {
    return localStorage.getItem(CHOICE_KEY) ?? 'auto';
  } catch {
    return 'auto';
  }
};

export const writeModelChoice = (choice: ModelChoice): void => {
  try {
    if (choice === 'auto') localStorage.removeItem(CHOICE_KEY);
    else localStorage.setItem(CHOICE_KEY, choice);
  } catch {
    // 저장 실패 — 이번 방문에만 적용된다
  }
};

export const autoModel = (manifest: ModelManifest, profile: DeviceProfile): WhisperModel => {
  const tier = defaultTier(profile);
  return manifest.models.find((model) => model.tier === tier) ?? manifest.models[0];
};

/** 고른 모델 — 고른 id 가 manifest 에 없으면(서버에서 빠짐) 자동 */
export const resolveModel = (manifest: ModelManifest, choice: ModelChoice, profile: DeviceProfile): WhisperModel =>
  (choice !== 'auto' ? manifest.models.find((model) => model.id === choice) : undefined) ?? autoModel(manifest, profile);