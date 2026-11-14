/**
 * One plain sentence per activity event, for the call's event log.
 * The text says only what the event says. It never claims a payment or a
 * delivery the event does not report.
 */
import type {ActivityEvent, ActivityPayloads} from '@/lib/api';
import {formatDateTime, formatMoney} from '@/lib/format';
import {statusView} from '@/lib/status';
import {actionLabel} from './journey';

function p<T extends keyof ActivityPayloads>(event: ActivityEvent, _type: T): ActivityPayloads[T] {
  return event.payload as unknown as ActivityPayloads[T];
}

export interface EventLine {
  title: string;
  /** True for payment data, which carries the sandbox label. */
  sandbox?: boolean;
}

export function describeEvent(event: ActivityEvent, timeZone: string): EventLine | null {
  switch (event.type) {
    case 'call.started': {
      const e = p(event, 'call.started');
      return {
        title:
          e.channel === 'test_console'
            ? 'Simulated call started'
            : `Incoming call${e.callerLast4 ? ` from a number ending in ${e.callerLast4}` : ''}`,
      };
    }
    case 'call.ended': {
      const e = p(event, 'call.ended');
      const how = e.reason === 'dropped' ? 'Call lost' : e.reason === 'failed' ? 'Call failed' : 'Call ended';
      return {title: `${how} after ${e.durationSec} seconds`};
    }
    case 'order.status_changed': {
      const e = p(event, 'order.status_changed');
      if (!e.orderId) return {title: `Call stage: ${statusView('callStage', e.to).label}`};
      return {title: `Order: ${statusView('order', e.to).label}`, sandbox: true};
    }
    case 'booking.status_changed': {
      const e = p(event, 'booking.status_changed');
      if (!e.bookingId) return {title: `Call stage: ${statusView('callStage', e.to).label}`};
      return {title: `Booking: ${statusView('booking', e.to).label}`};
    }
    case 'proposal.created': {
      const e = p(event, 'proposal.created');
      if (e.subjectType === 'order') {
        return {
          title: `Order proposed${e.totalMinor !== undefined ? `, total ${formatMoney(e.totalMinor, e.currency)}` : ''}`,
          sandbox: true,
        };
      }
      return {
        title: `Booking proposed${e.serviceName ? `: ${e.serviceName}` : ''}${e.startUtc ? ` at ${formatDateTime(e.startUtc, timeZone)}` : ''}`,
      };
    }
    case 'approval.requested':
      return {title: 'Approval requested from you'};
    case 'approval.decided': {
      const e = p(event, 'approval.decided');
      return {title: e.decision === 'APPROVED' ? 'You approved it' : 'You rejected it'};
    }
    case 'approval.expired':
      return {title: 'The approval expired. Nothing was sent.'};
    case 'execution.started': {
      const e = p(event, 'execution.started');
      return {title: `Started: ${actionLabel(e.actionType)}${e.attempt > 1 ? ` (attempt ${e.attempt})` : ''}`};
    }
    case 'execution.succeeded': {
      const e = p(event, 'execution.succeeded');
      return {title: `Done: ${actionLabel(e.actionType)}`};
    }
    case 'execution.failed': {
      const e = p(event, 'execution.failed');
      return {title: `Stopped: ${actionLabel(e.actionType)} (${e.errorCode})`};
    }
    case 'checkout.created': {
      const e = p(event, 'checkout.created');
      return {title: `Square checkout link created, order ${e.squareOrderId}`, sandbox: true};
    }
    case 'message.sent': {
      const e = p(event, 'message.sent');
      return {title: `Message accepted by ${e.channel} for the number ending in ${e.recipientLast4}`};
    }
    case 'message.failed': {
      const e = p(event, 'message.failed');
      return {title: statusView('messageDispatch', e.status).label};
    }
    case 'payment.verified': {
      const e = p(event, 'payment.verified');
      return {title: `Payment verified with Square, ${formatMoney(e.amountMinor, e.currency)}, ${e.squarePaymentId}`, sandbox: true};
    }
    case 'payment.failed': {
      const e = p(event, 'payment.failed');
      return {title: `Payment failed (${e.reason})`, sandbox: true};
    }
    case 'booking.verified': {
      const e = p(event, 'booking.verified');
      return {title: `Booking verified, Google event ${e.googleEventId}`};
    }
    case 'booking.slot_conflict':
      return {title: 'The slot was taken. No calendar event was created.'};
    case 'sync.queued':
      return {title: 'Google Sheets report queued'};
    case 'sync.succeeded':
      return {title: 'Google Sheets report written'};
    case 'sync.failed': {
      const e = p(event, 'sync.failed');
      return {title: e.final ? `Google Sheets report failed after ${e.attempts} attempts` : `Google Sheets report attempt ${e.attempts} failed, retrying`};
    }
    case 'guardrail.refused': {
      const e = p(event, 'guardrail.refused');
      return {title: `The agent refused a request (${e.rule})`};
    }
    default:
      return null;
  }
}
