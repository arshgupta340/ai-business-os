import { describe, expect, it } from 'vitest';
import { CapabilityIdSchema, ToolNameSchema } from '../pending-contracts';
import { REALTIME_MODEL } from './env';
import { builderVoiceClientSecretRequest, CLIENT_SECRET_TTL_SECONDS } from './session-config';

// The session configuration is the security boundary of owner voice. These
// tests fail if any deployed-agent tool, any capability, or any tool at all
// reaches the realtime model.

// Every deployed-agent tool name: the contract list plus the names SPEC 2.6 and
// FLOWS B4 give, written out so a rename in the contract cannot hide one.
const DEPLOYED_AGENT_TOOLS = new Set<string>([
  ...ToolNameSchema.options,
  'read_catalog',
  'read_business_facts',
  'quote_order',
  'propose_order',
  'get_order_status',
  'read_calendar_availability',
  'propose_booking',
]);

const request = builderVoiceClientSecretRequest(REALTIME_MODEL);
const serialized = JSON.stringify(request);

describe('builder voice session configuration', () => {
  it('binds the contract model and a short expiry', () => {
    expect(request.session.model).toBe('gpt-realtime-2.1');
    expect(request.session.type).toBe('realtime');
    expect(request.expires_after).toEqual({ anchor: 'created_at', seconds: CLIENT_SECRET_TTL_SECONDS });
    expect(CLIENT_SECRET_TTL_SECONDS).toBeGreaterThanOrEqual(10);
    expect(CLIENT_SECRET_TTL_SECONDS).toBeLessThanOrEqual(60);
  });

  it('gives the realtime model no tools at all (API.md 3.5, FLOWS A3)', () => {
    expect(request.session.tools).toEqual([]);
    expect(request.session.tool_choice).toBe('none');
    expect(serialized).not.toMatch(/"type":"(function|mcp)"/);
  });

  it('never names a deployed-agent tool anywhere in the configuration', () => {
    for (const name of DEPLOYED_AGENT_TOOLS) expect(serialized).not.toContain(name);
  });

  it('never names a capability ID, so no read, propose, write or message capability is offered', () => {
    for (const id of CapabilityIdSchema.options) expect(serialized).not.toContain(id);
  });

  it('does not let the model answer by itself: turns go through the builder endpoint', () => {
    expect(request.session.audio.input.turn_detection.create_response).toBe(false);
    expect(request.session.audio.input.transcription.model).toBeTruthy();
  });

  it('returns a fresh object each time, so a caller cannot change the shared config', () => {
    const a = builderVoiceClientSecretRequest(REALTIME_MODEL);
    expect(Object.isFrozen(a.session.tools)).toBe(true);
    expect(a).not.toBe(builderVoiceClientSecretRequest(REALTIME_MODEL));
  });
});
