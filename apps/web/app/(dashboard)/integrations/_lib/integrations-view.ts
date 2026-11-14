/**
 * Owner-facing text for the Integrations screen. Pure functions, so every
 * sentence can be tested without rendering.
 *
 * The integrations are preconnected test credentials (SPEC P-15, PRD
 * "preconnected test credentials"). There is no connect or reconnect route,
 * so no text here offers one.
 */
import {
  isApiError,
  payloadOf,
  type ActivityEvent,
  type IntegrationHealthEntry,
  type IntegrationProvider,
} from '@/lib/api';
import {PROVIDER_LABELS} from '@/components/shell/ConnectionHealth';
import {statusView} from '@/lib/status';

/** The event types this screen lists as integration events. */
export const INTEGRATION_EVENT_TYPES = ['webhook.rejected', 'sync.failed', 'message.failed', 'execution.failed'] as const;

/** What the product uses each provider for, in one plain sentence. */
export const PROVIDER_PURPOSE: Record<IntegrationProvider, string> = {
  square: 'Takes payments through checkout links.',
  twilio: 'Runs the phone line your agent answers.',
  openai: 'Runs the builder and the voice model your agent talks with.',
  google_calendar: 'Holds the bookings your agent creates.',
  google_sheets: 'Holds the report sheet where orders and bookings are added.',
  message_channel: 'Sends the payment link or the booking confirmation to the customer.',
};

export type Channel = NonNullable<IntegrationHealthEntry['channel']>;

export const CHANNEL_LABEL: Record<Channel, string> = {
  surge: 'Surge text message',
  android_gateway: 'Text message from the Android phone',
  whatsapp_sandbox: 'WhatsApp sandbox',
  qr_only: 'QR code only',
  agentphone: 'AgentPhone text message',
};

/** The sentence about the active message channel. */
export function channelText(channel: Channel | undefined): string {
  if (!channel) return 'The server did not report which channel is active.';
  if (channel === 'qr_only') {
    return 'Active channel: QR code only. Links are shown as a QR code on the Live operations screen and no message is sent.';
  }
  return `Active channel: ${CHANNEL_LABEL[channel] ?? channel}.`;
}

export type Consequence = {
  /** What the owner will notice. */
  notice: string;
  /** What to do about it. */
  action: string;
};

const CHECK_AGAIN = 'Press Check now in a few minutes.';
const ASK_SERVER =
  'These are preconnected test credentials. If it stays like this, ask the person who runs the server to check its settings';

const CONSEQUENCES: Record<IntegrationProvider, Record<'degraded' | 'disconnected', Consequence>> = {
  square: {
    degraded: {
      notice: 'Checkout links may be slow to create, and paid orders may take longer to show as verified.',
      action: `${CHECK_AGAIN} An order is only marked paid after Square confirms it.`,
    },
    disconnected: {
      notice: 'Checkout links cannot be created, so approved orders stop before payment. Nothing is charged.',
      action: `${CHECK_AGAIN} ${ASK_SERVER} (SQUARE_ACCESS_TOKEN and SQUARE_LOCATION_ID).`,
    },
  },
  twilio: {
    degraded: {
      notice: 'Calls may not come through, or may drop in the middle.',
      action: `${CHECK_AGAIN} You can still try your agent with a simulated call on its agent page.`,
    },
    disconnected: {
      notice: 'The phone line does not answer. Callers do not reach your agent.',
      action: `${CHECK_AGAIN} Try your agent with a simulated call meanwhile. ${ASK_SERVER} (TWILIO_PHONE_NUMBER).`,
    },
  },
  openai: {
    degraded: {
      notice: 'The builder and your phone agent may answer slowly.',
      action: CHECK_AGAIN,
    },
    disconnected: {
      notice: 'The builder cannot reply, and your phone agent cannot talk to callers.',
      action: `${CHECK_AGAIN} ${ASK_SERVER} (OPENAI_API_KEY).`,
    },
  },
  google_calendar: {
    degraded: {
      notice: 'Free times may load slowly, and bookings may take longer to confirm.',
      action: `${CHECK_AGAIN} A booking is only shown as booked after the calendar confirms it.`,
    },
    disconnected: {
      notice: 'Bookings cannot be created, and your agent cannot check free times.',
      action: `${CHECK_AGAIN} ${ASK_SERVER} (GOOGLE_CALENDAR_ID, shared with the service account).`,
    },
  },
  google_sheets: {
    degraded: {
      notice: 'The report sheet may update late. Orders and bookings are still saved here.',
      action: CHECK_AGAIN,
    },
    disconnected: {
      notice: 'The report sheet is not updated. Orders and bookings are still saved here, and the sheet will catch up when it is back.',
      action: `${CHECK_AGAIN} ${ASK_SERVER} (GOOGLE_SHEET_ID, shared with the service account).`,
    },
  },
  message_channel: {
    degraded: {
      notice: 'Messages to customers may be late or may not arrive.',
      action: 'Show the customer the QR code on the Live operations screen if the link does not arrive.',
    },
    disconnected: {
      notice: 'No message reaches the customer. The link is still shown as a QR code on the Live operations screen.',
      action: `Show the customer the QR code. ${CHECK_AGAIN} ${ASK_SERVER} (MESSAGE_CHANNEL).`,
    },
  },
};

/** What the owner notices and what to do, or null when the provider is connected. */
export function consequenceFor(provider: IntegrationProvider, state: IntegrationHealthEntry['state']): Consequence | null {
  if (state === 'connected') return null;
  return CONSEQUENCES[provider]?.[state] ?? null;
}

const STEP_LABEL: Record<string, string> = {
  'square.checkout.create': 'Creating the Square checkout link (sandbox)',
  'message.checkout.send': 'Sending the payment link to the customer',
  'calendar.event.create': 'Creating the calendar booking',
  'message.booking.confirm': 'Sending the booking confirmation',
  'sheets.order.append': 'Adding the order to the report sheet',
  'sheets.booking.append': 'Adding the booking to the report sheet',
  'square.catalog.price.update': 'Changing the price in Square (sandbox)',
  'local.order.record': 'Saving the order',
  'local.booking.record': 'Saving the booking',
  'local.fact.update': 'Saving the business fact',
  'local.catalog.sync': 'Refreshing the menu from Square',
};

export type IntegrationEventLine = {title: string; payment: boolean};

/** Plain-language line for one integration event. No customer data is read. */
export function describeIntegrationEvent(event: ActivityEvent): IntegrationEventLine {
  switch (event.type) {
    case 'webhook.rejected': {
      const p = payloadOf({...event, type: 'webhook.rejected'});
      // AgentPhone sends webhooks but has no health card of its own, so it is not in PROVIDER_LABELS.
      const provider = p.provider === 'agentphone' ? 'AgentPhone' : PROVIDER_LABELS[p.provider] ?? p.provider;
      const why = p.reason === 'signature_invalid' ? 'its signature did not match' : 'it was malformed';
      return {title: `Rejected a ${provider} webhook because ${why}. Nothing changed.`, payment: p.provider === 'square'};
    }
    case 'sync.failed': {
      const p = payloadOf({...event, type: 'sync.failed'});
      if (p.target === 'catalog') {
        return {
          title: p.final ? 'Menu refresh from Square failed.' : `Menu refresh from Square failed, retrying (attempt ${p.attempts}).`,
          payment: false,
        };
      }
      return {
        title: p.final
          ? 'Report sheet update failed and will not retry.'
          : `Report sheet update failed, retrying (attempt ${p.attempts}).`,
        payment: false,
      };
    }
    case 'message.failed': {
      const p = payloadOf({...event, type: 'message.failed'});
      const label = statusView('messageDispatch', p.status).label;
      const channel = CHANNEL_LABEL[p.channel as Channel];
      return {title: channel ? `${label} (${channel}).` : `${label}.`, payment: false};
    }
    case 'execution.failed': {
      const p = payloadOf({...event, type: 'execution.failed'});
      const step = STEP_LABEL[p.actionType] ?? p.actionType;
      return {title: `Step failed: ${step}.`, payment: p.actionType.startsWith('square.')};
    }
    default:
      return {title: event.type, payment: false};
  }
}

/** Owner-facing text for an error (screen data map, rule 9). */
export function errorText(error: unknown): string {
  if (!isApiError(error)) return 'Something went wrong. Try again.';
  switch (error.code) {
    case 'UNAUTHENTICATED':
      return 'You are signed out. Sign in again.';
    case 'FORBIDDEN_BUSINESS':
      return 'You do not have access to this business.';
    case 'NOT_FOUND':
      return 'Not found in this business.';
    case 'INTEGRATION_UNAVAILABLE': {
      const raw = error.details?.provider;
      const name = typeof raw === 'string' ? (PROVIDER_LABELS[raw as IntegrationProvider] ?? raw) : 'A provider';
      return `${name} is not responding.`;
    }
    default:
      if (error.kind === 'network') return 'Could not reach the server.';
      return error.message;
  }
}

/** Retry only when the error allows it. Errors that are not ApiError are treated as retryable. */
export function canRetry(error: unknown): boolean {
  return isApiError(error) ? error.retryable : true;
}
