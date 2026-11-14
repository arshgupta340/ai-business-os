import type { CallStatus, MessageDispatchStatus } from '@abos/contracts';
import { makeActivity } from './square.js';
import type { StoredWebhook, WebhookDependencies } from './types.js';

const callStatuses: Record<string, { status: CallStatus; reason: 'completed' | 'dropped' | 'failed' } | undefined> = {
  completed: { status: 'COMPLETED', reason: 'completed' },
  busy: { status: 'DROPPED', reason: 'dropped' },
  'no-answer': { status: 'DROPPED', reason: 'dropped' },
  canceled: { status: 'DROPPED', reason: 'dropped' },
  failed: { status: 'FAILED', reason: 'failed' },
};
const messageStatuses: Record<string, MessageDispatchStatus | undefined> = {
  queued: 'QUEUED', accepted: 'QUEUED', sending: 'QUEUED', sent: 'SENT', delivered: 'DELIVERED', read: 'DELIVERED', failed: 'FAILED', undelivered: 'FAILED',
};

export function parseTwilioStatus(params: Record<string, string>): Omit<StoredWebhook, 'id' | 'businessId'> | undefined {
  if (params.CallSid && params.CallStatus && (Object.hasOwn(callStatuses, params.CallStatus) ? callStatuses[params.CallStatus] : undefined)) {
    return { source: 'twilio_status', providerEventId: `${params.CallSid}:${params.CallStatus}`, eventType: 'call.status', payload: { providerId: params.CallSid, status: params.CallStatus } };
  }
  if (params.MessageSid && params.MessageStatus && (Object.hasOwn(messageStatuses, params.MessageStatus) ? messageStatuses[params.MessageStatus] : undefined)) {
    return { source: 'twilio_status', providerEventId: `${params.MessageSid}:${params.MessageStatus}`, eventType: 'message.status', payload: { providerId: params.MessageSid, status: params.MessageStatus } };
  }
  return undefined;
}

export async function processTwilioStatus(deps: WebhookDependencies, event: StoredWebhook): Promise<void> {
  const { providerId, status } = event.payload;
  if (!providerId || !status) return;
  if (event.eventType === 'call.status') {
    const mapped = Object.hasOwn(callStatuses, status) ? callStatuses[status] : undefined;
    if (!mapped) return;
    const call = await deps.calls.findByProviderId(providerId);
    if (!call || call.businessId !== event.businessId) return;
    const now = deps.clock.now();
    if (!await deps.calls.endOnce(call.id, mapped.status, now.toISOString())) return;
    const duration = (now.getTime() - Date.parse(call.startedAt)) / 1000;
    await deps.activity.write(makeActivity(deps, call.businessId, call.id, { type: 'call.ended', payload: { callId: call.id, status: mapped.status, reason: mapped.reason, durationSec: Number.isFinite(duration) ? Math.max(0, duration) : 0 } }));
  } else if (event.eventType === 'message.status') {
    const mapped = Object.hasOwn(messageStatuses, status) ? messageStatuses[status] : undefined;
    if (!mapped) return;
    const dispatch = await deps.dispatch.findByProviderId(providerId);
    if (!dispatch || dispatch.businessId !== event.businessId || dispatch.channel !== 'whatsapp_sandbox') return;
    if (!await deps.dispatch.updateStatus(dispatch.id, mapped)) return;
    if (mapped === 'FAILED') await deps.activity.write(makeActivity(deps, dispatch.businessId, dispatch.id, { type: 'message.failed', payload: { dispatchId: dispatch.id, subjectId: dispatch.subjectId, channel: dispatch.channel, status: 'FAILED' } }));
  }
}
