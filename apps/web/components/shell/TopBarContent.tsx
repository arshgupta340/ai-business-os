'use client';

import {HStack} from '@astryxdesign/core/HStack';
import {VStack} from '@astryxdesign/core/VStack';
import {useTopNavRenderMode} from '@astryxdesign/core/TopNav';
import {BusinessSelector} from './BusinessSelector';
import {ConnectionHealth} from './ConnectionHealth';
import {OwnerControls} from './OwnerControls';

/**
 * TopNav start slot. AppShell renders the TopNav three ways:
 * - "default" (wide screens): the full top bar, so this is the business selector.
 * - "mobile-bar" (below the md breakpoint): only the heading, the end slot and
 *   the menu toggle. The start slot is not shown there.
 * - "drawer": the mobile menu. The start slot opens it, so the business
 *   selector, connection health and sign out sit above the sections.
 */
export function TopBarStartContent() {
  const mode = useTopNavRenderMode();
  if (mode === 'drawer') {
    return (
      <VStack gap={3} hAlign="stretch">
        <BusinessSelector width="100%" />
        <ConnectionHealth />
        <OwnerControls />
      </VStack>
    );
  }
  return <BusinessSelector />;
}

/**
 * TopNav end slot. On a narrow screen the bar keeps only the app name and the
 * menu toggle, so these controls move into the drawer (TopBarStartContent).
 */
export function TopBarEndContent() {
  const mode = useTopNavRenderMode();
  if (mode === 'mobile-bar') return null;
  return (
    <HStack gap={3} vAlign="center">
      <ConnectionHealth />
      <OwnerControls />
    </HStack>
  );
}
