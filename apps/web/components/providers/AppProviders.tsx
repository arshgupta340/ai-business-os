'use client';

import type {ReactNode} from 'react';
import NextLink from 'next/link';
import {LinkProvider} from '@astryxdesign/core/Link';
import {Theme} from '@astryxdesign/core/theme';
import {themes, defaultThemeSlug} from '../../astryx-themes';
import {AuthProvider} from '@/lib/session/auth';
import {ApiBusinessProvider} from '@/lib/session';
import {ApiProvider} from '@/lib/api/provider';
import {OwnerDataBoundary} from './OwnerDataBoundary';
import {SessionErrorHandler} from './SessionErrorHandler';

/** Every app-wide provider, in one place. Wraps the whole app in app/layout.tsx. */
export function AppProviders({children}: {children: ReactNode}) {
  return (
    <Theme theme={themes[defaultThemeSlug]} mode="system">
      <LinkProvider component={NextLink}>
        <AuthProvider>
          {/* Data layer: React Query, plus the MSW worker in mock mode. */}
          <ApiProvider>
            {/* Clears cached data and owner state on sign-out or a change of owner. */}
            <OwnerDataBoundary>
              {/* useBusiness(): the list comes from GET /api/businesses. Only mock mode shows the seeded list while it loads or after it fails; real mode shows nothing the server has not returned. */}
              <ApiBusinessProvider>
                <SessionErrorHandler />
                {children}
              </ApiBusinessProvider>
            </OwnerDataBoundary>
          </ApiProvider>
        </AuthProvider>
      </LinkProvider>
    </Theme>
  );
}
