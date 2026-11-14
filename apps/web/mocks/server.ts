/** Node entry for tests: the same handlers on msw/node. */
import { setupServer } from "msw/node";
import { handlers } from "./handlers";

export const server = setupServer(...handlers);

export { mockControls } from "./timeline";
export { resetDb, getState } from "./db";
export { setMockTiming, FAST_TIMING, DEFAULT_TIMING, whenIdle } from "./scheduler";
