'use client';

import type {ReactNode} from 'react';
import NextLink from 'next/link';
import {LinkProvider} from '@astryxdesign/core/Link';
import {Theme} from '@astryxdesign/core/theme';
import {themes, defaultThemeSlug} from '../../astryx-themes';
import {AuthProvider} from '@/lib/session/auth';
import {ApiBusinessProvider} from '@/lib/session';
import {ApiProvider} from '@/lib/api/provider';
import {SessionErrorHandler} from './SessionErrorHandler';

/** Every app-wide provider, in one place. Wraps the whole app in app/layout.tsx. */
export function AppProviders({children}: {children: ReactNode}) {
  return (
    <Theme theme={themes[defaultThemeSlug]} mode="system">
      <LinkProvider component={NextLink}>
        <AuthProvider>
          {/* Data layer: React Query, plus the MSW worker in mock mode. */}
          <ApiProvider>
            {/* useBusiness(): the list comes from GET /api/businesses, with the seeded list as fallback. */}
            <ApiBusinessProvider>
              <SessionErrorHandler />
              {children}
            </ApiBusinessProvider>
          </ApiProvider>
        </AuthProvider>
      </LinkProvider>
    </Theme>
  );
}
