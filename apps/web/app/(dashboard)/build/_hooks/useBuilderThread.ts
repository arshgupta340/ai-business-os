'use client';
/**
 * The builder thread: the session's messages, the owner's pending turn and the
 * one send function. Typed chat uses it now. The voice task (U-12) attaches to
 * the same thread through useBuilderThreadContext() and calls
 * send(transcript, "voice") for each final transcript, so spoken and typed
 * turns land in one message list.
 */
import {createContext, useCallback, useContext, useEffect, useRef, useState} from 'react';
import {ApiError, isApiError, useBuilderSession, useSendBuilderMessage} from '@/lib/api';
import {readNotes, rememberSession, writeNotes} from '../_lib/memory';
import {builderSendErrorView, EMPTY_NOTES, mergeTurn, type TurnNotes} from '../_lib/spec';

export type InputMode = 'text' | 'voice';

export type PendingTurn =
  | {status: 'sending'; text: string; inputMode: InputMode}
  | {status: 'failed'; text: string; inputMode: InputMode; error: ApiError};

function asApiError(err: unknown): ApiError {
  if (isApiError(err)) return err;
  return new ApiError({
    code: 'INTERNAL',
    message: 'Something went wrong while sending. Try again.',
    status: 0,
    retryable: true,
    kind: 'network',
  });
}

export function useBuilderThread(businessId: string | null, sessionId: string | null) {
  const query = useBuilderSession(businessId, sessionId);
  const sendMutation = useSendBuilderMessage(businessId, sessionId);
  const {mutateAsync} = sendMutation;
  const {refetch} = query;
  const [pending, setPending] = useState<PendingTurn | null>(null);
  const [notes, setNotes] = useState<TurnNotes>(EMPTY_NOTES);
  const notesRef = useRef<TurnNotes>(EMPTY_NOTES);
  const sendingRef = useRef(false);
  const currentSession = useRef<string | null>(sessionId);

  // A new session starts with its own stored notes and no pending turn.
  useEffect(() => {
    currentSession.current = sessionId;
    const stored = readNotes(sessionId);
    notesRef.current = stored;
    setNotes(stored);
    setPending(null);
  }, [sessionId]);

  // Remember the session for this business once the server has returned it.
  const loaded = query.data;
  useEffect(() => {
    if (loaded && businessId && loaded.businessId === businessId) rememberSession(businessId, loaded.id);
  }, [loaded, businessId]);

  const send = useCallback(
    async (text: string, inputMode: InputMode = 'text'): Promise<boolean> => {
      const trimmed = text.trim();
      const target = sessionId;
      if (!trimmed || !target || sendingRef.current) return false;
      sendingRef.current = true;
      setPending({status: 'sending', text: trimmed, inputMode});
      try {
        // Resolves after the session (with both new messages) has been refetched.
        const turn = await mutateAsync({text: trimmed, inputMode});
        const base = currentSession.current === target ? notesRef.current : readNotes(target);
        const next = mergeTurn(base, turn);
        writeNotes(target, next);
        if (currentSession.current === target) {
          notesRef.current = next;
          setNotes(next);
          setPending(null);
        }
        return true;
      } catch (err) {
        const error = asApiError(err);
        if (currentSession.current === target) {
          setPending({status: 'failed', text: trimmed, inputMode, error});
          // The server changed or closed the session while the turn ran. Show it
          // as it is now before the owner sends again. The session stays
          // remembered: it is not forgotten or marked broken here.
          if (builderSendErrorView(error).refreshSession) void refetch();
        }
        return false;
      } finally {
        sendingRef.current = false;
      }
    },
    [sessionId, mutateAsync, refetch],
  );

  /** Sends the failed message again, unchanged. */
  const retry = useCallback(() => {
    if (pending?.status !== 'failed') return Promise.resolve(false);
    return send(pending.text, pending.inputMode);
  }, [pending, send]);

  /** Drops the failed message and returns its text so the owner can edit it. */
  const takeFailedText = useCallback((): string => {
    if (pending?.status !== 'failed') return '';
    const text = pending.text;
    setPending(null);
    return text;
  }, [pending]);

  const session = query.data;
  const messages = session?.messages ?? [];

  return {
    sessionId,
    session,
    messages,
    isLoading: query.isPending && !!sessionId,
    loadError: (query.error as ApiError | null) ?? null,
    reload: query.refetch,
    pending,
    isSending: pending?.status === 'sending',
    notes,
    hasOwnerTurn: messages.some((m) => m.role === 'owner'),
    send,
    retry,
    takeFailedText,
  };
}

export type BuilderThread = ReturnType<typeof useBuilderThread>;

export const BuilderThreadContext = createContext<BuilderThread | null>(null);

/** For components inside the Build screen, including the voice session (U-12). */
export function useBuilderThreadContext(): BuilderThread {
  const value = useContext(BuilderThreadContext);
  if (!value) throw new Error('useBuilderThreadContext must be used inside the Build an Agent screen.');
  return value;
}
