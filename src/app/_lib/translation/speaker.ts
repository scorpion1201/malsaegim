import type { MicTracks, TranslationCall } from './translationCall';

export type SpeakerState = {
  /** 사용자 의사. 설정에 저장된다 */
  intent: 'on' | 'off';
  /** 자동재생 차단 */
  blocked: boolean;
  /** 에코 퓨즈 작동 */
  fuseTripped: boolean;
};

export type SpeakerView = 'on' | 'off' | 'blocked' | 'fuse';

export const audible = (state: SpeakerState): boolean => state.intent === 'on' && !state.blocked && !state.fuseTripped;

export const speakerView = (state: SpeakerState): SpeakerView => {
  if (state.intent === 'off') return 'off';
  if (state.blocked) return 'blocked';
  return state.fuseTripped ? 'fuse' : 'on';
};

type SpeakerContext = { audio: HTMLAudioElement; call: TranslationCall | null; tracks: MicTracks };

/**
 * 에코가 새지 않는 순서: 켜기는 AEC 트랙으로 바꾼 뒤 소리를 내고, 끄기는 소리를 끈 뒤 원음으로 돌린다.
 * pause, srcObject 제거는 쓰지 않는다. 다시 켤 때 재생 재시작 실패를 만들지 않기 위해서다.
 */
export const applySpeaker = async (next: SpeakerState, { audio, call, tracks }: SpeakerContext): Promise<SpeakerState> => {
  const mute = async () => {
    audio.muted = true;
    await call?.setSendTrack(tracks.raw).catch(() => {});
  };

  if (!audible(next)) {
    await mute();
    return next;
  }
  try {
    if (tracks.aec) await call?.setSendTrack(tracks.aec);
  } catch {
    // 에코 위험을 만들지 않는다 — 켜기를 거부하고 끔으로 남는다
    await mute();
    return { ...next, intent: 'off' };
  }
  audio.muted = false;
  try {
    await audio.play();
    return next;
  } catch (error) {
    if (error instanceof Error && error.name === 'NotAllowedError') {
      await mute();
      return { ...next, blocked: true };
    }
    // 원격 트랙이 아직 없으면 재생할 것이 없을 뿐이다
    return next;
  }
};