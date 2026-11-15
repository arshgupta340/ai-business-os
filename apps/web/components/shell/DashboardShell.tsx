'use client';

// Adapted from the Astryx block template "AppShellTopNavWithSideNav"
// (npx @astryxdesign/cli template AppShellTopNavWithSideNav). The frame,
// slots and content padding are kept. Heroicons were removed: the shell uses
// no icons so the app depends on Astryx only.

import {useEffect, type ReactNode} from 'react';
import {useRouter} from 'next/navigation';
import {AppShell} from '@astryxdesign/core/AppShell';
import {TopNav, TopNavHeading} from '@astryxdesign/core/TopNav';
import {LoadingState} from '@/components/LoadingState';
import {isDemoScript} from '@/lib/env';
import {BusinessListGate} from '@/lib/session';
import {useAuth} from '@/lib/session/auth';
import {ApprovalsBadgeSync} from './ApprovalsBadgeSync';
import {SandboxBanner} from './SandboxBanner';
import {ShellBadgesProvider, useShellBadges} from './ShellBadgesContext';
import {Sidebar} from './Sidebar';
import {TopBarEndContent, TopBarStartContent} from './TopBarContent';

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
      // The bar is hidden while the scripted demo is on (NEXT_PUBLIC_DEMO_SCRIPT=1), so it is not on
      // the projector for the whole demo. Every payment amount keeps its own "Sandbox" badge, on the
      // order card, the approvals list and the menu, so payment data is still labelled (AGENTS.md rule 4).
      banner={isDemoScript() ? undefined : <SandboxBanner />}
      topNav={
        <TopNav
          label="Main navigation"
          heading={<TopNavHeading heading={APP_NAME} headingHref="/overview" />}
          // Below the md breakpoint the bar shows the app name and the menu
          // toggle; the selector, health and sign out move into the menu.
          startContent={<TopBarStartContent />}
          endContent={<TopBarEndContent />}
        />
      }
      sideNav={<Sidebar pendingApprovalsCount={pendingApprovalsCount} />}>
      {status === 'signed_in' ? <BusinessListGate>{children}</BusinessListGate> : <LoadingState label="Checking sign-in" />}
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
