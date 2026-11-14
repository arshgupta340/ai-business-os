'use client';

// Adapted from the Astryx block template "AppShellTopNavWithSideNav"
// (npx @astryxdesign/cli template AppShellTopNavWithSideNav). The frame,
// slots and content padding are kept. Heroicons were removed: the shell uses
// no icons so the app depends on Astryx only.

import {useEffect, type ReactNode} from 'react';
import {useRouter} from 'next/navigation';
import {AppShell} from '@astryxdesign/core/AppShell';
import {HStack} from '@astryxdesign/core/HStack';
import {TopNav, TopNavHeading} from '@astryxdesign/core/TopNav';
import {LoadingState} from '@/components/LoadingState';
import {useAuth} from '@/lib/session/auth';
import {ApprovalsBadgeSync} from './ApprovalsBadgeSync';
import {BusinessSelector} from './BusinessSelector';
import {ConnectionHealth} from './ConnectionHealth';
import {OwnerControls} from './OwnerControls';
import {SandboxBanner} from './SandboxBanner';
import {ShellBadgesProvider, useShellBadges} from './ShellBadgesContext';
import {Sidebar} from './Sidebar';

export const APP_NAME = 'AI Business OS';

function ShellFrame({children}: {children: ReactNode}) {
  const {status} = useAuth();
  const {pendingApprovalsCount} = useShellBadges();
  const router = useRouter();

  // Guard: signed-out owners go to sign-in.
  useEffect(() => {
    if (status === 'signed_out') {
      router.replace('/sign-in');
    }
  }, [status, router]);

  return (
    <AppShell
      contentPadding={6}
      banner={<SandboxBanner />}
      topNav={
        <TopNav
          label="Main navigation"
          heading={<TopNavHeading heading={APP_NAME} headingHref="/overview" />}
          startContent={<BusinessSelector />}
          endContent={
            <HStack gap={3} vAlign="center">
              <ConnectionHealth />
              <OwnerControls />
            </HStack>
          }
        />
      }
      sideNav={<Sidebar pendingApprovalsCount={pendingApprovalsCount} />}>
      {status === 'signed_in' ? children : <LoadingState label="Checking sign-in" />}
    </AppShell>
  );
}

export function DashboardShell({children}: {children: ReactNode}) {
  return (
    <ShellBadgesProvider>
      <ApprovalsBadgeSync />
      <ShellFrame>{children}</ShellFrame>
    </ShellBadgesProvider>
  );
}
