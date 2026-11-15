/**
 * IDs for the agents the mock builder creates: agt_draft_1, agt_draft_2, and so
 * on. The count starts again when the mock data resets (a page load or
 * resetDb). The IDs are known ahead of time so the GitHub Pages build
 * (STATIC_EXPORT=1) can write a page for each: a static site has no page for an
 * ID it did not build.
 */
export const DRAFT_AGENT_ID_COUNT = 20;

let draftAgentCount = 0;

export function nextDraftAgentId(): string {
  draftAgentCount += 1;
  return `agt_draft_${draftAgentCount}`;
}

export function resetDraftAgentIds(): void {
  draftAgentCount = 0;
}

/** The first DRAFT_AGENT_ID_COUNT IDs nextDraftAgentId hands out. */
export function draftAgentIds(): string[] {
  return Array.from({length: DRAFT_AGENT_ID_COUNT}, (_, i) => `agt_draft_${i + 1}`);
}
