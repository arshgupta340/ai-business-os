'use client';

import {useEffect, useState} from 'react';
import {Banner} from '@astryxdesign/core/Banner';
import {getSessionStorage, takeSignInNotice} from '@/lib/session';

/**
 * Shows, once, why the owner landed on the sign-in page, for example after
 * the server answered UNAUTHENTICATED. Renders nothing when there is no notice.
 */
export function SessionNotice() {
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const stored = takeSignInNotice(getSessionStorage());
    if (stored) setNotice(stored);
  }, []);

  if (!notice) return null;
  return <Banner status="info" title={notice} container="card" collapsible={false} />;
}
