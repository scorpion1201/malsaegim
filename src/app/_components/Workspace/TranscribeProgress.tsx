'use client';

import styles from './Workspace.module.css';

type TranscribeProgressProps = {
  phase: 'idle' | 'splitting' | 'transcribing' | 'review' | 'error';
  readyCount: number;
  heldCount: number;
  totalCount: number | null;
  errorMessage: string | null;
  onCancel: () => void;
};

export const TranscribeProgress = ({
  phase,
  readyCount,
  heldCount,
  totalCount,
  errorMessage,
  onCancel,
}: TranscribeProgressProps) => {
  if (phase === 'idle') return null;
  const total = totalCount ?? Math.max(readyCount + heldCount, 1);
  const percent = totalCount === null ? 0 : Math.round((readyCount / Math.max(totalCount, 1)) * 100);
  const label =
         phase === 'splitting'
             ? '오디오를 나누는 중…'
             : phase === 'transcribing'
                 ? `인식 ${readyCount}/${totalCount ?? `${total}+`}${heldCount > 0 ? ` (순서 대기 ${heldCount})` : ''}`
                 : phase === 'review'
                     ? `인식 완료 — ${readyCount}개 조각`
                     : `오류: ${errorMessage ?? '알 수 없는 오류'}`;
  return (
       <div className={styles.progress} role="status">
           <div className={styles.progressBar}>
               <div
               className={phase === 'error' ? styles.progressFillError : styles.progressFill}
               style={{ width: `${phase === 'review' ? 100 : percent}%` }}
              />
           </div>
           <span className={styles.progressLabel}>{label}</span>
           {phase === 'splitting' || phase === 'transcribing' ? (
                <button type="button" className={styles.cancel} onClick={onCancel}>
                     취소
                </button>
              ) : null}
       </div>
     );
};