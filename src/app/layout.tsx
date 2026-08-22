import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '말새김',
  description: '녹음 파일을 받아쓰고 HWP/HWPX로 저장',
  icons: { icon: '/app-logo.png', apple: '/app-logo.png' },
};

const RootLayout = ({ children }: LayoutProps<'/'>) => (
   <html lang="ko">
     <body>{children}</body>
   </html>
);

export default RootLayout;