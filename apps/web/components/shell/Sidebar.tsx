'use client';

import {usePathname} from 'next/navigation';
import {Badge} from '@astryxdesign/core/Badge';
import {SideNav, SideNavItem, SideNavSection} from '@astryxdesign/core/SideNav';
import {NAV_ITEMS, isNavItemActive} from './nav';

export type SidebarProps = {
  /** Pending approvals. null or 0 hides the badge. */
  pendingApprovalsCount?: number | null;
};

export function Sidebar({pendingApprovalsCount = null}: SidebarProps) {
  const pathname = usePathname();
  return (
    <SideNav aria-label="Sections">
      <SideNavSection title="Sections" isHeaderHidden>
        {NAV_ITEMS.map((item) => (
          <SideNavItem
            key={item.key}
            label={item.label}
            href={item.href}
            isSelected={isNavItemActive(pathname, item.href)}
            endContent={
              item.key === 'approvals' && pendingApprovalsCount ? (
                <Badge label={String(pendingApprovalsCount)} variant="warning" />
              ) : undefined
            }
          />
        ))}
      </SideNavSection>
    </SideNav>
  );
}
