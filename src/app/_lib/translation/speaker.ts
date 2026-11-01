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

/**
 * 재협상 없이 재생만 켜고 끈다. 송신 트랙은 remote-only 에코 제거가 항상 켜져 있어 바꾸지 않는다.
 * pause, srcObject 제거는 쓰지 않는다. 다시 켤 때 재생 재시작 실패를 만들지 않기 위해서다.
 */
export const applySpeaker = async (next: SpeakerState, audio: HTMLAudioElement): Promise<SpeakerState> => {
  if (!audible(next)) {
    audio.muted = true;
    return next;
  }
  audio.muted = false;
  try {
    await audio.play();
    return next;
  } catch (error) {
    if (error instanceof Error && error.name === 'NotAllowedError') {
      audio.muted = true;
      return { ...next, blocked: true };
    }
    // 원격 트랙이 아직 없으면 재생할 것이 없을 뿐이다
    return next;
  }
};