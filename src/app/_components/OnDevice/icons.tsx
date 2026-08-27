const stroke = { fill: 'none', stroke: 'currentColor', strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;

/** 칩 모양 — On-Device 모델 표식 */
export const ChipIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} strokeWidth={1.8}>
    <rect x="4" y="4" width="16" height="16" rx="3" />
    <rect x="9" y="9" width="6" height="6" rx="1" />
    <path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2" />
  </svg>
);

export const DownloadIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" {...stroke} strokeWidth={2}>
    <path d="M12 3v12M6 11l6 6 6-6" />
    <path d="M4 21h16" />
  </svg>
);

export const CheckIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} strokeWidth={2.5}>
    <path d="M5 12l5 5L20 7" />
  </svg>
);

export const CrossIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" {...stroke} strokeWidth={2.5}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

/** 회전은 쓰는 쪽 CSS(animation: spin)로 준다 */
export const SpinnerIcon = ({ className }: { className?: string }) => (
  <svg className={className} width="16" height="16" viewBox="0 0 24 24" {...stroke} strokeWidth={2.5}>
    <path d="M12 3a9 9 0 1 0 9 9" />
  </svg>
);