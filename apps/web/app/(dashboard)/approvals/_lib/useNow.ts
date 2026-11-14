'use client';

import {useEffect, useState} from 'react';

/** The current time in ms, updated every `intervalMs` while `active` is true. Drives the expiry countdowns. */
export function useNow(active: boolean = true, intervalMs: number = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}
