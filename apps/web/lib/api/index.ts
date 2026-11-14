/**
 * The API layer for apps/web. Screens import from "@/lib/api" only.
 * See lib/api/README.md for every hook, its arguments and what it returns.
 */
export * from "./pending-contracts";
export type { ApiError as ApiErrorBody } from "./pending-contracts";
export * from "./api-shapes";
export * as api from "./client";
export { configureApiClient } from "./client";
export { ApiError, isApiError, ERROR_CODE_INFO, type ApiErrorKind } from "./errors";
export { isMockMode } from "./config";
export { queryKeys, type Resource } from "./query-keys";
export { invalidateForEvent, invalidationFor } from "./invalidation";
export * from "./hooks";
export { useActivityFeed, activityEventFromRow, type ActivityFeed, type ActivityFeedStatus } from "./useActivityFeed";
export { ApiProvider, createApiQueryClient } from "./provider";
export { useMockControls, getMockControls, type MockControls } from "./mock-bridge";
