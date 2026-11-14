'use client';

import type {ReactNode} from 'react';
import NextLink from 'next/link';
import {LinkProvider} from '@astryxdesign/core/Link';
import {Theme} from '@astryxdesign/core/theme';
import {themes, defaultThemeSlug} from '../../astryx-themes';
import {AuthProvider} from '@/lib/session/auth';
import {BusinessProvider} from '@/lib/session';

/** Every app-wide provider, in one place. Wraps the whole app in app/layout.tsx. */
export function AppProviders({children}: {children: ReactNode}) {
  return (
    <Theme theme={themes[defaultThemeSlug]} mode="system">
      <LinkProvider component={NextLink}>
        <AuthProvider>
          <BusinessProvider>
            {/* ApiProvider (from @/lib/api/provider) goes here, wrapping children. */}
            {children}
          </BusinessProvider>
        </AuthProvider>
      </LinkProvider>
    </Theme>
  );
}
