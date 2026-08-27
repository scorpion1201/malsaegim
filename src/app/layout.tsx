import type { Metadata } from 'next';
import { IBM_Plex_Sans_KR } from 'next/font/google';
import { DialogProvider } from './_components/Dialog/DialogProvider';
import { ModelProvider } from './_components/OnDevice/ModelProvider';
import { ToastProvider } from './_components/Toast/ToastProvider';
import { THEME_INIT_SCRIPT } from './_lib/theme';
import './globals.css';

const plexKr = IBM_Plex_Sans_KR({
  weight: ['400', '500', '600'],
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-plex-kr',
});

export const metadata: Metadata = {
  title: '말새김',
  description: '녹음 파일을 받아쓰고 HWP/HWPX로 저장',
  icons: { icon: '/app-logo.png', apple: '/app-logo.png' },
};

const RootLayout = ({ children }: LayoutProps<'/'>) => (
  <html lang="ko" className={plexKr.variable} suppressHydrationWarning>
    <head>
      <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
    </head>
    <body>
      <ToastProvider>
        <DialogProvider>
          <ModelProvider>{children}</ModelProvider>
        </DialogProvider>
      </ToastProvider>
    </body>
  </html>
);

export default RootLayout;