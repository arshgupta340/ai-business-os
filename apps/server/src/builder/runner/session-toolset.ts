import {
  ToolContextSchema,
  type ToolContext,
  type ToolHandler,
  type ToolInput,
  type ToolName,
  type ToolResult,
} from '@abos/contracts';
import { createMockToolsetRegistry, type MockToolsetRegistry } from '../../tools/mock/index';

// The one ToolHandler the text runner takes, in front of the shared mock
// toolset (apps/server/src/tools/mock). The shared toolset is one instance per
// business and test session, so this adapter routes each call to the instance
// of `ctx.testSessionId`, and `reset(key)` drops that one session's state.
//
// It reports `toolset: "mock"` and has no other path: every call lands in a
// mock toolset, which has no write path and returns `apv_mock_` approvals only.

export interface SessionToolset extends ToolHandler {
  readonly toolset: 'mock';
  reset(key: string): void;
}

export class SessionMockToolset implements SessionToolset {
  readonly toolset = 'mock' as const;
  private readonly registry: MockToolsetRegistry;

  // `now` is the runner's clock. The shared toolset would otherwise use the
  // fixed fixture time for quote expiry, minimum notice and pickup checks.
  constructor(now: () => Date, registry?: MockToolsetRegistry) {
    this.registry = registry ?? createMockToolsetRegistry({ now });
  }

  async call<N extends ToolName>(name: N, input: ToolInput[N], ctx: ToolContext): Promise<ToolResult<N>> {
    const checked = ToolContextSchema.safeParse(ctx);
    if (!checked.success) throw new Error('The mock toolset was called with a tool context that does not match the contract.');
    // A test or preview run always has a session. Without one there is no
    // instance to route to, and the call is refused rather than shared.
    if (checked.data.testSessionId === undefined) throw new Error('A mock tool call needs a testSessionId.');
    return this.registry.forSession(checked.data.testSessionId, checked.data.businessId).handler.call(name, input, ctx);
  }

  reset(key: string): void {
    this.registry.reset(key);
  }
}
