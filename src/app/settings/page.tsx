import type { Metadata } from 'next';
import { SettingsPage } from '@/app/_components/Settings/SettingsPage';

export const metadata: Metadata = {
  title: '설정 · 말새김',
};

const Page = () => <SettingsPage />;

export default Page;