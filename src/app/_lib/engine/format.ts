export const formatMb = (bytes: number): string => String(Math.round(bytes / 1048576));

/** 남은 시간 — 1분 미만은 5초 단위, 그 위는 분 단위 올림. 속도를 아직 모르면 "계산 중" */
export const formatEta = (sec: number | null): string => {
  if (sec === null) return '남은 시간 계산 중';
  if (sec < 60) return `남은 시간 약 ${Math.max(5, Math.round(sec / 5) * 5)}초`;
  return `남은 시간 약 ${Math.ceil(sec / 60)}분`;
};