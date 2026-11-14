/** Node entry for tests: the same handlers on msw/node. */
import { setupServer } from "msw/node";
import { handlers } from "./handlers";
import { setBuilderSessionStore } from "./db";

// Builder sessions persist only in the browser mock, never in the node test server.
setBuilderSessionStore(null);

export const server = setupServer(...handlers);

export { mockControls } from "./timeline";
export { resetDb, getState, setBuilderSessionStore, saveBuilderSessions, restoreBuilderSessions, BUILDER_SESSIONS_STORAGE_KEY } from "./db";
export { setMockTiming, FAST_TIMING, DEFAULT_TIMING, whenIdle } from "./scheduler";
