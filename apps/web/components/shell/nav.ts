/**
 * Sidebar items, in order (docs/PRD.md section 5, docs/SPEC.md 2.9).
 * "Activity" is the Live operations screen.
 */
export type NavItem = {
  key: 'overview' | 'build' | 'agents' | 'activity' | 'approvals' | 'knowledge' | 'integrations' | 'settings';
  label: string;
  href: string;
};

export const NAV_ITEMS: readonly NavItem[] = [
  {key: 'overview', label: 'Overview', href: '/overview'},
  {key: 'build', label: 'Build an Agent', href: '/build'},
  {key: 'agents', label: 'My Agents', href: '/agents'},
  {key: 'activity', label: 'Activity', href: '/activity'},
  {key: 'approvals', label: 'Approvals', href: '/approvals'},
  {key: 'knowledge', label: 'Business Knowledge', href: '/knowledge'},
  {key: 'integrations', label: 'Integrations', href: '/integrations'},
  {key: 'settings', label: 'Settings', href: '/settings'},
];

/** True when the pathname is the item's route or a page under it. */
export function isNavItemActive(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  return pathname === href || pathname.startsWith(`${href}/`);
}
