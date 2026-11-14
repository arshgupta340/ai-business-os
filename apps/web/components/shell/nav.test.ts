import {describe, expect, it} from 'vitest';
import {NAV_ITEMS, isNavItemActive} from './nav';

describe('sidebar items', () => {
  it('follow the PRD order and routes', () => {
    expect(NAV_ITEMS.map((i) => `${i.label} ${i.href}`)).toEqual([
      'Overview /overview',
      'Build an Agent /build',
      'My Agents /agents',
      'Activity /activity',
      'Approvals /approvals',
      'Business Knowledge /knowledge',
      'Integrations /integrations',
      'Settings /settings',
    ]);
  });

  it('marks the active item, including nested pages', () => {
    expect(isNavItemActive('/agents', '/agents')).toBe(true);
    expect(isNavItemActive('/agents/agt_1', '/agents')).toBe(true);
    expect(isNavItemActive('/agentsx', '/agents')).toBe(false);
    expect(isNavItemActive(null, '/agents')).toBe(false);
  });
});
