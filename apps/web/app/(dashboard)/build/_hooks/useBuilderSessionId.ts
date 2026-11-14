'use client';
/**
 * Which builder session the screen shows. The session ID lives in the URL as
 * ?session=<id>, so a reload resumes it. Each business remembers its last
 * session, so switching the business in the top bar resumes that business's
 * session or starts a new one (FLOWS.md A1: opening the screen creates one).
 */
import {useCallback, useEffect, useRef, useState} from 'react';
import {usePathname, useRouter, useSearchParams} from 'next/navigation';
import {isApiError, useCreateBuilderSession, type ApiError} from '@/lib/api';
import {businessOfSession, rememberSession, rememberedSession} from '../_lib/memory';

export const SESSION_PARAM = 'session';

export function useBuilderSessionId(businessId: string | null) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const urlId = params.get(SESSION_PARAM);
  const {mutateAsync} = useCreateBuilderSession(businessId);
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<ApiError | null>(null);
  const creatingFor = useRef<string | null>(null);
  const currentBusiness = useRef(businessId);
  currentBusiness.current = businessId;

  // The business a URL session belongs to: the remembered owner, or else the
  // business that was selected when the ID first appeared in the URL. A
  // session is only shown for its own business, so switching the business
  // never sends the old session ID with the new business ID.
  const firstSeen = useRef<{id: string; businessId: string} | null>(null);
  const owner = urlId ? businessOfSession(urlId) : null;
  if (urlId && businessId && firstSeen.current?.id !== urlId) {
    firstSeen.current = {id: urlId, businessId: owner ?? businessId};
  }
  const urlBusiness = urlId ? (owner ?? firstSeen.current?.businessId ?? null) : null;
  const sessionId = urlId && businessId && urlBusiness === businessId ? urlId : null;

  const showSession = useCallback(
    (id: string) => {
      router.replace(`${pathname}?${SESSION_PARAM}=${encodeURIComponent(id)}`);
    },
    [router, pathname],
  );

  const startNew = useCallback(async () => {
    if (!businessId || creatingFor.current === businessId) return;
    creatingFor.current = businessId;
    setIsCreating(true);
    setCreateError(null);
    try {
      const session = await mutateAsync();
      rememberSession(businessId, session.id);
      if (currentBusiness.current === businessId) showSession(session.id);
    } catch (err) {
      if (currentBusiness.current === businessId) {
        setCreateError(isApiError(err) ? err : null);
      }
    } finally {
      creatingFor.current = null;
      setIsCreating(false);
    }
  }, [businessId, mutateAsync, showSession]);

  const autoStartBlocked = createError !== null;

  useEffect(() => {
    if (!businessId || sessionId) return;
    const known = rememberedSession(businessId);
    if (known && known !== urlId) {
      showSession(known);
      return;
    }
    if (!autoStartBlocked) void startNew();
  }, [businessId, sessionId, urlId, autoStartBlocked, showSession, startNew]);

  // A new business clears an old creation error.
  useEffect(() => {
    setCreateError(null);
  }, [businessId]);

  return {sessionId, startNew, isCreating, createError};
}
