"use client";
/**
 * React Query hooks for every screen. Each business-scoped hook takes
 * businessId as an argument (pass useBusiness().businessId) and stays
 * disabled while it is null or undefined.
 *
 * Mutations never update the cache before the server answers. Success state
 * comes only from the server response or from a refetch after it.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import * as api from "./client";
import { queryKeys, type Resource } from "./query-keys";
import type { ApiError } from "./errors";
import type { ScopedQuery } from "./client";
import { newerThan, useHiddenBefore } from "../demo-reset";
import type {
  AgentRunResponse,
  ApprovalDecision,
  BuilderMessageBody,
  CreateAgentBody,
  ListFactsQuery,
  ProposeFactBody,
  ProposePriceBody,
  PublishBody,
  RollbackBody,
  UpdateBusinessBody,
} from "@abos/contracts";

type MaybeId = string | null | undefined;

function invalidate(qc: QueryClient, businessId: string, ...resources: Resource[]) {
  return Promise.all(resources.map((r) => qc.invalidateQueries({ queryKey: queryKeys.resource(businessId, r) })));
}

/**
 * The demo reset (lib/demo-reset.ts): once the presenter has reset the app, the
 * lists of run data leave out what happened at or before that moment. Without
 * a reset the page is returned as the server sent it.
 */
function useNewerOnly<P extends { items: unknown[] }>(at: (item: P["items"][number]) => string | undefined) {
  const cutoff = useHiddenBefore();
  const atRef = useRef(at);
  atRef.current = at;
  return useMemo(
    () => (cutoff === null ? undefined : (page: P): P => ({ ...page, items: newerThan(page.items, cutoff, atRef.current) })),
    [cutoff],
  );
}

function requireId(id: MaybeId, name: string): string {
  if (!id) throw new Error(`${name} is required`);
  return id;
}

// ----------------------------------------------------------- businesses

/** Pass `{ enabled: false }` to hold the call, for example while signed out. */
export function useBusinesses(options: { enabled?: boolean } = {}) {
  return useQuery({ queryKey: queryKeys.businesses(), queryFn: () => api.listBusinesses(), enabled: options.enabled ?? true });
}

export function useBusiness(businessId: MaybeId) {
  return useQuery({
    queryKey: queryKeys.business(businessId ?? ""),
    queryFn: () => api.getBusiness(requireId(businessId, "businessId")),
    enabled: !!businessId,
  });
}

export function useUpdateBusiness(businessId: MaybeId) {
  const qc = useQueryClient();
  return useMutation<Awaited<ReturnType<typeof api.updateBusiness>>, ApiError, UpdateBusinessBody>({
    mutationFn: (patch) => api.updateBusiness(requireId(businessId, "businessId"), patch),
    onSuccess: async () => {
      await Promise.all([invalidate(qc, businessId!, "business"), qc.invalidateQueries({ queryKey: queryKeys.businesses() })]);
    },
  });
}

// ---------------------------------------------------------------- facts

export function useFacts(businessId: MaybeId, query: ListFactsQuery = {}) {
  return useQuery({
    queryKey: queryKeys.facts(businessId ?? "", query),
    queryFn: () => api.getFacts(requireId(businessId, "businessId"), query),
    enabled: !!businessId,
  });
}

/** Creates a fact_edit approval. Show the confirm dialog, then call useDecideApproval with its payloadHash. */
export function useProposeFact(businessId: MaybeId) {
  const qc = useQueryClient();
  return useMutation<Awaited<ReturnType<typeof api.proposeFact>>, ApiError, ProposeFactBody>({
    mutationFn: (body) => api.proposeFact(requireId(businessId, "businessId"), body),
    onSuccess: async () => {
      await invalidate(qc, businessId!, "approvals");
    },
  });
}

export function useSyncCatalog(businessId: MaybeId) {
  const qc = useQueryClient();
  return useMutation<Awaited<ReturnType<typeof api.syncCatalog>>, ApiError, void>({
    mutationFn: () => api.syncCatalog(requireId(businessId, "businessId")),
    onSuccess: async () => {
      await invalidate(qc, businessId!, "facts", "catalog", "activity");
    },
  });
}

/** SHOULD tier. Creates a price_edit approval. */
export function useProposePrice(businessId: MaybeId) {
  const qc = useQueryClient();
  return useMutation<Awaited<ReturnType<typeof api.proposePrice>>, ApiError, ProposePriceBody>({
    mutationFn: (body) => api.proposePrice(requireId(businessId, "businessId"), body),
    onSuccess: async () => {
      await invalidate(qc, businessId!, "approvals");
    },
  });
}

/** Catalog cache grouped by item (display prices only; quotes come from Square). */
export function useCatalog(businessId: MaybeId) {
  return useQuery({
    queryKey: queryKeys.catalog(businessId ?? ""),
    queryFn: () => api.getCatalog(requireId(businessId, "businessId")),
    enabled: !!businessId,
  });
}

/**
 * Keep the authoritative value for a conflict. No approval is needed because
 * nothing external is written. To prefer an uploaded price, use useProposePrice.
 */
export function useResolveConflict(businessId: MaybeId) {
  const qc = useQueryClient();
  return useMutation<Awaited<ReturnType<typeof api.resolveConflict>>, ApiError, { conflictId: string }>({
    mutationFn: ({ conflictId }) => api.resolveConflict(requireId(businessId, "businessId"), conflictId),
    onSettled: async () => {
      await invalidate(qc, businessId!, "facts", "files", "agents");
    },
  });
}

// ---------------------------------------------------------------- files

export function useUploadFile(businessId: MaybeId) {
  const qc = useQueryClient();
  return useMutation<Awaited<ReturnType<typeof api.uploadFile>>, ApiError, { file: Blob; fileName?: string }>({
    mutationFn: ({ file, fileName }) => api.uploadFile(requireId(businessId, "businessId"), file, fileName),
    onSuccess: (file) => {
      qc.setQueryData(queryKeys.file(businessId!, file.id), file);
    },
  });
}

/**
 * One uploaded file. While extraction is PENDING or EXTRACTING it also polls
 * every 2 seconds, as a backup to the extraction.completed event.
 */
export function useFile(businessId: MaybeId, fileId: MaybeId) {
  return useQuery({
    queryKey: queryKeys.file(businessId ?? "", fileId ?? ""),
    queryFn: () => api.getFile(requireId(businessId, "businessId"), requireId(fileId, "fileId")),
    enabled: !!businessId && !!fileId,
    refetchInterval: (q) => {
      const state = q.state.data?.extractionState;
      return state === "PENDING" || state === "EXTRACTING" ? 2000 : false;
    },
  });
}

// ------------------------------------------------------ builder sessions

export function useCreateBuilderSession(businessId: MaybeId) {
  const qc = useQueryClient();
  return useMutation<Awaited<ReturnType<typeof api.createBuilderSession>>, ApiError, { agentId?: string } | void>({
    mutationFn: (body) => api.createBuilderSession(requireId(businessId, "businessId"), body ?? {}),
    onSuccess: (session) => {
      qc.setQueryData(queryKeys.builderSession(businessId!, session.id), session);
    },
  });
}

export function useBuilderSession(businessId: MaybeId, sessionId: MaybeId) {
  return useQuery({
    queryKey: queryKeys.builderSession(businessId ?? "", sessionId ?? ""),
    queryFn: () => api.getBuilderSession(requireId(businessId, "businessId"), requireId(sessionId, "sessionId")),
    enabled: !!businessId && !!sessionId,
  });
}

/** Sends one owner turn. The session (with both new messages) is refetched after the server replies. */
export function useSendBuilderMessage(businessId: MaybeId, sessionId: MaybeId) {
  const qc = useQueryClient();
  return useMutation<Awaited<ReturnType<typeof api.sendBuilderMessage>>, ApiError, BuilderMessageBody>({
    mutationFn: (body) => api.sendBuilderMessage(requireId(businessId, "businessId"), requireId(sessionId, "sessionId"), body),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: queryKeys.builderSession(businessId!, sessionId!) });
    },
  });
}

export function useRealtimeClientSecret(businessId: MaybeId) {
  return useMutation<Awaited<ReturnType<typeof api.createRealtimeClientSecret>>, ApiError, { builderSessionId: string }>({
    mutationFn: (body) => api.createRealtimeClientSecret(requireId(businessId, "businessId"), body),
  });
}

// ---------------------------------------------------------------- agents

export function useAgents(businessId: MaybeId, query: ScopedQuery<"listAgents"> = {}) {
  return useQuery({
    queryKey: queryKeys.agents(businessId ?? "", query),
    queryFn: () => api.listAgents(requireId(businessId, "businessId"), query),
    enabled: !!businessId,
  });
}

export function useAgent(businessId: MaybeId, agentId: MaybeId) {
  return useQuery({
    queryKey: queryKeys.agent(businessId ?? "", agentId ?? ""),
    queryFn: () => api.getAgent(requireId(businessId, "businessId"), requireId(agentId, "agentId")),
    enabled: !!businessId && !!agentId,
  });
}

export function useAgentVersions(businessId: MaybeId, agentId: MaybeId, query: ScopedQuery<"listAgentVersions"> = {}) {
  return useQuery({
    queryKey: queryKeys.agentVersions(businessId ?? "", agentId ?? "", query),
    queryFn: () => api.listAgentVersions(requireId(businessId, "businessId"), requireId(agentId, "agentId"), query),
    enabled: !!businessId && !!agentId,
  });
}

export function useCreateAgent(businessId: MaybeId) {
  const qc = useQueryClient();
  return useMutation<Awaited<ReturnType<typeof api.createAgent>>, ApiError, CreateAgentBody>({
    mutationFn: (body) => api.createAgent(requireId(businessId, "businessId"), body),
    onSuccess: async () => {
      await invalidate(qc, businessId!, "agents");
    },
  });
}

/** Mock toolset only. Never causes a write. */
export function usePreviewAgent(businessId: MaybeId, agentId: MaybeId) {
  return useMutation<Awaited<ReturnType<typeof api.previewAgent>>, ApiError, { scenarios?: string[] } | void>({
    mutationFn: (body) => api.previewAgent(requireId(businessId, "businessId"), requireId(agentId, "agentId"), body ?? {}),
  });
}

export function usePublishAgent(businessId: MaybeId, agentId: MaybeId) {
  const qc = useQueryClient();
  return useMutation<Awaited<ReturnType<typeof api.publishAgent>>, ApiError, PublishBody>({
    mutationFn: (body) => api.publishAgent(requireId(businessId, "businessId"), requireId(agentId, "agentId"), body),
    onSettled: async () => {
      await Promise.all([invalidate(qc, businessId!, "agents", "facts"), qc.invalidateQueries({ queryKey: queryKeys.liveAgent() })]);
    },
  });
}

export function usePauseAgent(businessId: MaybeId, agentId: MaybeId) {
  const qc = useQueryClient();
  return useMutation<Awaited<ReturnType<typeof api.pauseAgent>>, ApiError, void>({
    mutationFn: () => api.pauseAgent(requireId(businessId, "businessId"), requireId(agentId, "agentId")),
    onSettled: async () => {
      await Promise.all([invalidate(qc, businessId!, "agents"), qc.invalidateQueries({ queryKey: queryKeys.liveAgent() })]);
    },
  });
}

/** SHOULD tier. */
export function useRollbackAgent(businessId: MaybeId, agentId: MaybeId) {
  const qc = useQueryClient();
  return useMutation<Awaited<ReturnType<typeof api.rollbackAgent>>, ApiError, RollbackBody>({
    mutationFn: (body) => api.rollbackAgent(requireId(businessId, "businessId"), requireId(agentId, "agentId"), body),
    onSettled: async () => {
      await Promise.all([invalidate(qc, businessId!, "agents"), qc.invalidateQueries({ queryKey: queryKeys.liveAgent() })]);
    },
  });
}

export interface ConversationTurn {
  role: "owner" | "agent";
  text: string;
  /** Present on agent turns. */
  response?: AgentRunResponse;
}

/**
 * Text conversation with an agent.
 * - mode "test": POST /api/agents/:id/test, mock tools, label it as a test with mock tools.
 * - mode "sim-call": POST /api/agents/:id/sim-call, published agents only, label it "simulated call".
 * The hook keeps the testSessionId or callId between turns. Turns are added
 * only after the server answers.
 */
export function useAgentConversation(businessId: MaybeId, agentId: MaybeId, mode: "test" | "sim-call") {
  const qc = useQueryClient();
  const [turns, setTurns] = useState<ConversationTurn[]>([]);
  const sessionRef = useRef<string | undefined>(undefined);
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);

  const mutation = useMutation<AgentRunResponse, ApiError, { message: string; end?: boolean }>({
    mutationFn: ({ message, end }) => {
      const bid = requireId(businessId, "businessId");
      const aid = requireId(agentId, "agentId");
      return mode === "test"
        ? api.testAgent(bid, aid, { message, testSessionId: sessionRef.current })
        : api.simCall(bid, aid, { message, callId: sessionRef.current, end });
    },
    onSuccess: (res, vars) => {
      const id = mode === "test" ? res.testSessionId : res.callId;
      sessionRef.current = id;
      setSessionId(id);
      setTurns((prev) => [...prev, { role: "owner", text: vars.message }, { role: "agent", text: res.reply, response: res }]);
      if (mode === "sim-call") void invalidate(qc, businessId!, "calls", "orders", "bookings", "approvals", "activity");
    },
  });

  const reset = useCallback(() => {
    sessionRef.current = undefined;
    setSessionId(undefined);
    setTurns([]);
    mutation.reset();
  }, [mutation]);

  return {
    mode,
    turns,
    /** testSessionId in test mode, callId in sim-call mode. */
    sessionId,
    send: (message: string) => mutation.mutateAsync({ message }),
    /** sim-call only: hang up. */
    end: () => mutation.mutateAsync({ message: "", end: true }),
    isPending: mutation.isPending,
    error: mutation.error,
    reset,
  };
}

// ------------------------------------------------------------ live agent

export function useLiveAgent() {
  return useQuery({ queryKey: queryKeys.liveAgent(), queryFn: () => api.getLiveAgent() });
}

export function useSetLiveAgent() {
  const qc = useQueryClient();
  return useMutation<Awaited<ReturnType<typeof api.setLiveAgent>>, ApiError, { agentId: string }>({
    mutationFn: (body) => api.setLiveAgent(body),
    onSettled: async (data) => {
      await qc.invalidateQueries({ queryKey: queryKeys.liveAgent() });
      if (data?.businessId) await invalidate(qc, data.businessId, "agents");
      else await qc.invalidateQueries({ queryKey: ["api", "biz"] });
    },
  });
}

// ------------------------------------------------------------- approvals

export function useApprovals(businessId: MaybeId, query: ScopedQuery<"listApprovals"> = {}) {
  const select = useNewerOnly<Awaited<ReturnType<typeof api.listApprovals>>>((x) => x.createdAt);
  return useQuery({
    queryKey: queryKeys.approvals(businessId ?? "", query),
    queryFn: () => api.listApprovals(requireId(businessId, "businessId"), query),
    enabled: !!businessId,
    select,
  });
}

export function useApproval(businessId: MaybeId, approvalId: MaybeId) {
  return useQuery({
    queryKey: queryKeys.approval(businessId ?? "", approvalId ?? ""),
    queryFn: () => api.getApproval(requireId(businessId, "businessId"), requireId(approvalId, "approvalId")),
    enabled: !!businessId && !!approvalId,
  });
}

export interface DecideVariables extends ApprovalDecision {
  approvalId: string;
}

/**
 * Approve or reject. Sends the payloadHash the UI displayed and an
 * Idempotency-Key that stays the same for the same approval, decision and
 * hash, so a retry after a timeout replays the first answer.
 * Disable the buttons while isPending. Show "Approved" only from the
 * returned approval state; execution progress arrives as activity events.
 * On PAYLOAD_HASH_MISMATCH the approval is refetched so the owner sees the new payload.
 */
export function useDecideApproval(businessId: MaybeId) {
  const qc = useQueryClient();
  const keys = useRef(new Map<string, string>());

  const keyFor = (v: DecideVariables) => {
    const k = `${v.approvalId}|${v.decision}|${v.payloadHash}`;
    let key = keys.current.get(k);
    if (!key) {
      key = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `idem_${Date.now()}_${Math.random()}`;
      keys.current.set(k, key);
    }
    return key;
  };

  return useMutation<Awaited<ReturnType<typeof api.decideApproval>>, ApiError, DecideVariables>({
    mutationFn: (v) =>
      api.decideApproval(
        requireId(businessId, "businessId"),
        v.approvalId,
        { decision: v.decision, payloadHash: v.payloadHash, reason: v.reason },
        { idempotencyKey: keyFor(v) },
      ),
    onSettled: async () => {
      await invalidate(qc, businessId!, "approvals", "orders", "bookings", "facts", "activity");
    },
  });
}

// ------------------------------------------------------- orders, bookings

export function useOrders(businessId: MaybeId, query: ScopedQuery<"listOrders"> = {}) {
  const select = useNewerOnly<Awaited<ReturnType<typeof api.listOrders>>>((x) => x.createdAt);
  return useQuery({
    queryKey: queryKeys.orders(businessId ?? "", query),
    queryFn: () => api.listOrders(requireId(businessId, "businessId"), query),
    enabled: !!businessId,
    select,
  });
}

export function useOrder(businessId: MaybeId, orderId: MaybeId) {
  return useQuery({
    queryKey: queryKeys.order(businessId ?? "", orderId ?? ""),
    queryFn: () => api.getOrder(requireId(businessId, "businessId"), requireId(orderId, "orderId")),
    enabled: !!businessId && !!orderId,
  });
}

/** Link and QR data (always sandbox). Render a QR from qrText when ready is true. */
export function useOrderCheckout(businessId: MaybeId, orderId: MaybeId) {
  return useQuery({
    queryKey: queryKeys.orderCheckout(businessId ?? "", orderId ?? ""),
    queryFn: () => api.getOrderCheckout(requireId(businessId, "businessId"), requireId(orderId, "orderId")),
    enabled: !!businessId && !!orderId,
  });
}

export function useBookings(businessId: MaybeId, query: ScopedQuery<"listBookings"> = {}) {
  const select = useNewerOnly<Awaited<ReturnType<typeof api.listBookings>>>((x) => x.createdAt);
  return useQuery({
    queryKey: queryKeys.bookings(businessId ?? "", query),
    queryFn: () => api.listBookings(requireId(businessId, "businessId"), query),
    enabled: !!businessId,
    select,
  });
}

export function useBooking(businessId: MaybeId, bookingId: MaybeId) {
  return useQuery({
    queryKey: queryKeys.booking(businessId ?? "", bookingId ?? ""),
    queryFn: () => api.getBooking(requireId(businessId, "businessId"), requireId(bookingId, "bookingId")),
    enabled: !!businessId && !!bookingId,
  });
}

// --------------------------------------------------------------- activity

export function useActivity(businessId: MaybeId, query: ScopedQuery<"listActivity"> = {}) {
  const select = useNewerOnly<Awaited<ReturnType<typeof api.listActivity>>>((x) => x.occurredAt);
  return useQuery({
    queryKey: queryKeys.activity(businessId ?? "", query),
    queryFn: () => api.listActivity(requireId(businessId, "businessId"), query),
    enabled: !!businessId,
    select,
  });
}

// ------------------------------------------------------------------ calls

export function useCalls(businessId: MaybeId, query: ScopedQuery<"listCalls"> = {}) {
  const select = useNewerOnly<Awaited<ReturnType<typeof api.listCalls>>>((x) => x.startedAt);
  return useQuery({
    queryKey: queryKeys.calls(businessId ?? "", query),
    queryFn: () => api.listCalls(requireId(businessId, "businessId"), query),
    enabled: !!businessId,
    select,
  });
}

export function useCall(businessId: MaybeId, callId: MaybeId) {
  return useQuery({
    queryKey: queryKeys.call(businessId ?? "", callId ?? ""),
    queryFn: () => api.getCall(requireId(businessId, "businessId"), requireId(callId, "callId")),
    enabled: !!businessId && !!callId,
  });
}

// ------------------------------------------------------ recovery (SHOULD, P-19)

/** SHOULD tier. Leave the Cancel button out until the server has POST /api/orders/:id/cancel. */
export function useCancelOrder(businessId: MaybeId) {
  const qc = useQueryClient();
  return useMutation<Awaited<ReturnType<typeof api.cancelOrder>>, ApiError, { orderId: string }>({
    mutationFn: ({ orderId }) => api.cancelOrder(requireId(businessId, "businessId"), orderId),
    onSettled: async () => {
      await invalidate(qc, businessId!, "orders", "activity");
    },
  });
}

/** SHOULD tier. Leave Retry and Abandon out until the server has POST /api/executions/:id/resolve. */
export function useResolveExecution(businessId: MaybeId) {
  const qc = useQueryClient();
  return useMutation<
    Awaited<ReturnType<typeof api.resolveExecution>>,
    ApiError,
    { executionId: string; action: "retry" | "abandon" }
  >({
    mutationFn: ({ executionId, action }) => api.resolveExecution(requireId(businessId, "businessId"), executionId, { action }),
    onSettled: async () => {
      await invalidate(qc, businessId!, "orders", "bookings", "approvals", "activity");
    },
  });
}

// --------------------------------------------------------------- telemetry

/** SHOULD tier. p50 and p95 per metric. */
export function useTelemetry(businessId: MaybeId, options: { since?: string } = {}) {
  return useQuery({
    queryKey: queryKeys.telemetry(businessId ?? "", options.since),
    queryFn: () => api.getTelemetry(requireId(businessId, "businessId"), options),
    enabled: !!businessId,
  });
}

// ------------------------------------------------------------ integrations

export function useIntegrationsHealth(businessId: MaybeId) {
  return useQuery({
    queryKey: queryKeys.health(businessId ?? ""),
    queryFn: () => api.getIntegrationsHealth(requireId(businessId, "businessId")),
    enabled: !!businessId,
    refetchInterval: 60_000,
  });
}

/** Runs live checks now (refresh=1) and stores the answer in the health query. */
export function useRefreshIntegrationsHealth(businessId: MaybeId) {
  const qc = useQueryClient();
  return useMutation<Awaited<ReturnType<typeof api.getIntegrationsHealth>>, ApiError, void>({
    mutationFn: () => api.getIntegrationsHealth(requireId(businessId, "businessId"), { refresh: true }),
    onSuccess: (data) => {
      qc.setQueryData(queryKeys.health(businessId!), data);
    },
  });
}
