import type {Metadata, Viewport} from 'next';
import type {ReactNode} from 'react';
import {AppProviders} from '@/components/providers/AppProviders';
import './globals.css';

export const metadata: Metadata = {
  title: 'AI Business OS',
  description: 'Build a phone agent for your business and approve every action it proposes.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({children}: {children: ReactNode}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
