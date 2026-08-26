'use client';

import styles from './Workspace.module.css';

type UploaderProps = {
  disabled: boolean;
  fileName: string | null;
  onSelect: (file: File) => void;
};

export const Uploader = ({ disabled, fileName, onSelect }: UploaderProps) => (
     <label className={styles.uploader}>
           <input
           type="file"
           accept="audio/mpeg,.mp3"
           disabled={disabled}
           className={styles.fileInput}
           onChange={(event) => {
             const file = event.target.files?.[0];
             if (file) onSelect(file);
             event.target.value = '';
             }}
          />
           <span className={styles.uploaderButton}>{disabled ? '처리 중…' : 'mp3 선택'}</span>
           <span className={styles.fileName}>{fileName ?? '파일 없음'}</span>
     </label>
);