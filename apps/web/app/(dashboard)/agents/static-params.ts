import {agents, STAGE_SHOPS} from '@abos/contracts/fixtures';
import {draftAgentIds} from '@/mocks/agent-ids';

/**
 * The agent pages the GitHub Pages build (STATIC_EXPORT=1) writes out: every
 * agent in the mock fixtures, the three stage shops' agents and the IDs the mock
 * builder hands out. Any other build returns none, so every ID is still rendered
 * on request as before.
 */
export function agentStaticParams(): {id: string}[] {
  if (process.env.STATIC_EXPORT !== '1') return [];
  const ids = new Set([
    ...agents.map((agent) => agent.id),
    ...Object.values(STAGE_SHOPS).map((shop) => shop.agent.id),
    ...draftAgentIds(),
  ]);
  return [...ids].map((id) => ({id}));
}
