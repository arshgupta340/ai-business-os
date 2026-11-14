/**
 * The API layer for apps/web. Screens import from "@/lib/api" only.
 * See lib/api/README.md for every hook, its arguments and what it returns.
 *
 * Every type and schema comes from @abos/contracts and is re-exported here.
 * One name is local and shadows a contract export on purpose: ApiError is
 * the class the client throws, and the contract's error envelope type is
 * re-exported as ApiErrorBody. ERROR_CODE_INFO (HTTP status and retryable flag per code) and
 * activityEventFromRow (the Realtime row mapping) are the contract's own.
 */
export * from "@abos/contracts";
export type { ApiError as ApiErrorBody } from "@abos/contracts";
export * as api from "./client";
export { configureApiClient } from "./client";
export { ApiError, isApiError, type ApiErrorKind } from "./errors";
export { payloadOf } from "./payload";
export { isMockMode } from "./config";
export { queryKeys, PENDING_APPROVALS_QUERY, type Resource } from "./query-keys";
export { invalidateForEvent, invalidationFor } from "./invalidation";
export * from "./hooks";
export { useActivityFeed, type ActivityFeed, type ActivityFeedStatus } from "./useActivityFeed";
export { ApiProvider, createApiQueryClient } from "./provider";
export { subscribeApiErrors, reportApiError, businessIdFromQueryKey, type ApiErrorReport } from "./session-errors";
export { useMockControls, getMockControls, subscribeMockReset, type MockControls } from "./mock-bridge";
