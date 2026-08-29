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

const SITE_NAME = '말새김';
const SITE_DESCRIPTION = '실시간·녹음을 전사를 합니다.';

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000'),
  title: SITE_NAME,
  description: SITE_DESCRIPTION,
  icons: { icon: '/app-logo.png', apple: '/app-logo.png' },
  openGraph: {
    type: 'website',
    siteName: SITE_NAME,
    title: SITE_NAME,
    description: SITE_DESCRIPTION,
    locale: 'ko_KR',
    url: '/',
    images: [{ url: '/open-graph.png' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: SITE_NAME,
    description: SITE_DESCRIPTION,
    images: ['/open-graph.png'],
  },
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