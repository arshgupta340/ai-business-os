import { afterEach, describe, expect, it } from "vitest";
import { DRAFT_AGENT_ID_COUNT, draftAgentIds, nextDraftAgentId, resetDraftAgentIds } from "./agent-ids";

afterEach(() => resetDraftAgentIds());

describe("draft agent IDs", () => {
  it("hands out agt_draft_1, agt_draft_2, ... and starts again after a reset", () => {
    expect([nextDraftAgentId(), nextDraftAgentId()]).toEqual(["agt_draft_1", "agt_draft_2"]);
    resetDraftAgentIds();
    expect(nextDraftAgentId()).toBe("agt_draft_1");
  });

  it("lists, for the static build, exactly the first IDs it hands out", () => {
    const handedOut = Array.from({ length: DRAFT_AGENT_ID_COUNT }, () => nextDraftAgentId());
    expect(draftAgentIds()).toEqual(handedOut);
  });
});
