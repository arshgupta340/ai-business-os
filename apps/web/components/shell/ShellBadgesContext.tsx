'use client';

import {createContext, useContext, useMemo, useState, type ReactNode} from 'react';

/**
 * Counts shown on sidebar items. Today only the pending approvals count.
 * null (the default) hides the badge. A later task (U-04) calls
 * setPendingApprovalsCount once it knows the number.
 */
export type ShellBadgesValue = {
  pendingApprovalsCount: number | null;
  setPendingApprovalsCount: (count: number | null) => void;
};

const ShellBadgesContext = createContext<ShellBadgesValue | null>(null);

export function ShellBadgesProvider({children}: {children: ReactNode}) {
  const [pendingApprovalsCount, setPendingApprovalsCount] = useState<number | null>(null);
  const value = useMemo(() => ({pendingApprovalsCount, setPendingApprovalsCount}), [pendingApprovalsCount]);
  return <ShellBadgesContext.Provider value={value}>{children}</ShellBadgesContext.Provider>;
}

export function useShellBadges(): ShellBadgesValue {
  const value = useContext(ShellBadgesContext);
  if (!value) {
    throw new Error('useShellBadges must be used inside ShellBadgesProvider.');
  }
  return value;
}
