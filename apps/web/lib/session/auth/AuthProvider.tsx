'use client';

import {createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode} from 'react';
import type {User} from '@supabase/supabase-js';
import {isMockMode} from '@/lib/env';
import {getBrowserStorage} from '@/lib/storage';
import {getSupabaseBrowserClient} from '@/lib/supabase/client';
import {clearMockSession, readMockSession, writeMockSession} from './mock-session';
import {DEMO_OWNER, type Owner} from './owner';

export type AuthStatus = 'loading' | 'signed_in' | 'signed_out';

export type SignInResult = {ok: true} | {ok: false; message: string};

export type AuthContextValue = {
  status: AuthStatus;
  owner: Owner | null;
  /** In mock mode the arguments are ignored and the demo owner signs in. */
  signIn: (email: string, password: string) => Promise<SignInResult>;
  signOut: () => Promise<void>;
  isMock: boolean;
  /** Set when not in mock mode and the Supabase values are missing. */
  configError: string | null;
};

export const SUPABASE_CONFIG_ERROR =
  'Sign-in is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in apps/web/.env.local, or run in mock mode with NEXT_PUBLIC_MOCK=1.';

const AuthContext = createContext<AuthContextValue | null>(null);

function ownerFromUser(user: User): Owner {
  const email = user.email ?? '';
  const metadata = user.user_metadata as Record<string, unknown> | undefined;
  const name = metadata?.display_name ?? metadata?.full_name ?? metadata?.name;
  return {id: user.id, email, displayName: typeof name === 'string' && name ? name : email};
}

export function AuthProvider({children}: {children: ReactNode}) {
  const isMock = isMockMode();
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [owner, setOwner] = useState<Owner | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);

  useEffect(() => {
    if (isMock) {
      const stored = readMockSession(getBrowserStorage());
      setOwner(stored);
      setStatus(stored ? 'signed_in' : 'signed_out');
      return;
    }
    const supabase = getSupabaseBrowserClient();
    if (!supabase) {
      setConfigError(SUPABASE_CONFIG_ERROR);
      setOwner(null);
      setStatus('signed_out');
      return;
    }
    let isActive = true;
    supabase.auth
      .getSession()
      .then(({data}) => {
        if (!isActive) return;
        const user = data.session?.user;
        setOwner(user ? ownerFromUser(user) : null);
        setStatus(user ? 'signed_in' : 'signed_out');
      })
      .catch(() => {
        if (!isActive) return;
        setOwner(null);
        setStatus('signed_out');
      });
    const {data: listener} = supabase.auth.onAuthStateChange((_event, session) => {
      if (!isActive) return;
      const user = session?.user;
      setOwner(user ? ownerFromUser(user) : null);
      setStatus(user ? 'signed_in' : 'signed_out');
    });
    return () => {
      isActive = false;
      listener.subscription.unsubscribe();
    };
  }, [isMock]);

  const signIn = useCallback(
    async (email: string, password: string): Promise<SignInResult> => {
      if (isMock) {
        writeMockSession(getBrowserStorage(), DEMO_OWNER);
        setOwner(DEMO_OWNER);
        setStatus('signed_in');
        return {ok: true};
      }
      const supabase = getSupabaseBrowserClient();
      if (!supabase) {
        return {ok: false, message: SUPABASE_CONFIG_ERROR};
      }
      if (!email || !password) {
        return {ok: false, message: 'Enter your email and password.'};
      }
      try {
        const {data, error} = await supabase.auth.signInWithPassword({email, password});
        if (error || !data.user) {
          return {ok: false, message: 'Sign-in failed. Check your email and password and try again.'};
        }
        setOwner(ownerFromUser(data.user));
        setStatus('signed_in');
        return {ok: true};
      } catch {
        return {ok: false, message: 'Sign-in failed because the auth service could not be reached. Try again.'};
      }
    },
    [isMock],
  );

  const signOut = useCallback(async () => {
    if (isMock) {
      clearMockSession(getBrowserStorage());
    } else {
      const supabase = getSupabaseBrowserClient();
      if (supabase) {
        try {
          await supabase.auth.signOut();
        } catch {
          // The local state still clears below.
        }
      }
    }
    setOwner(null);
    setStatus('signed_out');
  }, [isMock]);

  const value = useMemo<AuthContextValue>(
    () => ({status, owner, signIn, signOut, isMock, configError}),
    [status, owner, signIn, signOut, isMock, configError],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error('useAuth must be used inside AuthProvider.');
  }
  return value;
}
