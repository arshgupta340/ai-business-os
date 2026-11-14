import { GUARDRAIL_REFUSAL_THRESHOLD, TOOL_FAILURE_THRESHOLD } from './constants';
import type { FallbackDecision, FallbackInput } from './types';

/** Deterministic precedence: explicit human request, unavailable agent/model/line, repeated failures. */
export function decideFallback(input: FallbackInput): FallbackDecision {
  if (input.callerRequestedPerson === true) return { handoff: true, reason: 'caller_requested_person' };
  if (input.liveAgentMissing === true || input.liveAgentUnpublished === true) return { handoff: true, reason: 'live_agent_unavailable' };
  if (input.modelSessionFailed === true && input.modelSessionReady === false) return { handoff: true, reason: 'model_session_failed' };
  if (input.phoneLineOverloaded === true) return { handoff: true, reason: 'phone_line_overloaded' };
  if (typeof input.guardrailRefusals === 'number' && input.guardrailRefusals >= GUARDRAIL_REFUSAL_THRESHOLD) return { handoff: true, reason: 'repeated_guardrail_refusals' };
  if (typeof input.toolFailures === 'number' && input.toolFailures >= TOOL_FAILURE_THRESHOLD) return { handoff: true, reason: 'repeated_tool_failures' };
  return { handoff: false };
}
