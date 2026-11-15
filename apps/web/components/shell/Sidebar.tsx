'use client';

import {usePathname} from 'next/navigation';
import {Badge} from '@astryxdesign/core/Badge';
import {SideNav, SideNavItem, SideNavSection} from '@astryxdesign/core/SideNav';
import {Activity, BookOpen, Bot, ClipboardCheck, LayoutDashboard, Plug, Settings, Sparkles, type LucideIcon} from 'lucide-react';
import {NAV_ITEMS, isNavItemActive, type NavItem} from './nav';

// One icon per tab, from Lucide: the icon set the Astryx Neutral theme itself uses,
// drawn at the size the theme draws its own icons.
const NAV_ICONS: Record<NavItem['key'], LucideIcon> = {
  overview: LayoutDashboard,
  build: Sparkles,
  agents: Bot,
  activity: Activity,
  approvals: ClipboardCheck,
  knowledge: BookOpen,
  integrations: Plug,
  settings: Settings,
};

// The selected tab is tinted with the accent color and its label takes the accent, so it reads as the
// tab you are on without being the heaviest thing on the screen.
const SELECTED_STYLE = {backgroundColor: 'var(--abos-tint-strong)', color: 'var(--color-text-accent)', fontWeight: 650} as const;

export type SidebarProps = {
  /** Pending approvals. null or 0 hides the badge. */
  pendingApprovalsCount?: number | null;
};

export function Sidebar({pendingApprovalsCount = null}: SidebarProps) {
  const pathname = usePathname();
  return (
    <SideNav aria-label="Sections">
      <SideNavSection title="Sections" isHeaderHidden>
        {NAV_ITEMS.map((item) => {
          const TabIcon = NAV_ICONS[item.key];
          const isSelected = isNavItemActive(pathname, item.href);
          return (
          <SideNavItem
            key={item.key}
            label={item.label}
            href={item.href}
            icon={<TabIcon size="1em" aria-hidden />}
            isSelected={isSelected}
            style={isSelected ? SELECTED_STYLE : undefined}
            endContent={
              item.key === 'approvals' && pendingApprovalsCount ? (
                <Badge label={String(pendingApprovalsCount)} variant="info" />
              ) : undefined
            }
          />
          );
        })}
      </SideNavSection>
    </SideNav>
  );
}
