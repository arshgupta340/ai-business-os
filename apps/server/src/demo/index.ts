// D-13 DEMO MODE entry points: the settings check, the wiring the composition root calls, and the one
// place a call's tool list gains the demo menu tool.
import type { AgentSpec, CapabilityId } from '@abos/contracts';
import { createMessageAdapter, type MessageAdapter } from '../adapters/message/index';
import { sandboxPay, type SandboxFetch } from '../adapters/square/sandbox-pay';
import type { SeamDeps } from '../compose/seams';
import type { Db } from '../db/index';
import type { Env } from '../env';
import { demoConfig } from './config';
import { createDemoMode, type DemoDeps, type DemoMode } from './service';

export type { DemoMode } from './service';
export { demoConfig } from './config';

/** The demo menu tool's capability. Never in a template; added to a call only by `demoCallSpec`. */
export const DEMO_MENU_CAPABILITY: CapabilityId = 'menu.message.propose';

/**
 * The spec a call is pinned with. In demo mode, for a listed caller on the restaurant template, the demo
 * menu capability is added, so `checkSessionCapabilities` gives the session `propose_menu_message` and the
 * toolset allows it. Otherwise the capability is removed if a spec ever carried it, so no other call is offered it.
 */
export function demoCallSpec(spec: AgentSpec, listedDemoCaller: boolean): AgentSpec {
  const has = spec.capabilities.includes(DEMO_MENU_CAPABILITY);
  if (listedDemoCaller && spec.template === 'restaurant_order_taker') return has ? spec : { ...spec, capabilities: [...spec.capabilities, DEMO_MENU_CAPABILITY] };
  return has ? { ...spec, capabilities: spec.capabilities.filter((c) => c !== DEMO_MENU_CAPABILITY) } : spec;
}

/** Test seams for demo mode. Production passes none. */
export type DemoOverrides = {
  message?: MessageAdapter | undefined;
  square?: { fetch: SandboxFetch; accessToken: string } | undefined;
  tickMs?: number | undefined;
};

export function buildDemoMode(env: Env, deps: {
  db: Db; hasDb: boolean; log: SeamDeps['log']; now: () => Date; squareLocationId: string | undefined;
  catalog: DemoDeps['catalog']; reconcile?: (() => Promise<unknown>) | undefined; overrides?: DemoOverrides | undefined;
}): DemoMode | undefined {
  const config = demoConfig(env);
  if (!config.on) {
    deps.log.info({ demo: 'off', reason: config.reason }, 'demo mode is off');
    return undefined;
  }
  if (!deps.hasDb) {
    deps.log.info({ demo: 'off', reason: 'missing DATABASE_URL' }, 'demo mode is off');
    return undefined;
  }
  let message: MessageAdapter;
  try {
    // Always the Twilio WhatsApp sandbox, whatever MESSAGE_CHANNEL says (that stays qr_only for real proposals).
    message = deps.overrides?.message ?? createMessageAdapter({ channel: 'whatsapp_sandbox', fetch: (url, init) => fetch(url, init), timeoutMs: 7000,
      whatsappSandbox: { accountSid: config.twilio.accountSid, authToken: config.twilio.authToken, ...(config.twilio.from ? { from: config.twilio.from } : {}) } });
  } catch {
    deps.log.info({ demo: 'off', reason: 'TWILIO_WHATSAPP_FROM is not usable' }, 'demo mode is off');
    return undefined;
  }
  const accessToken = deps.overrides?.square?.accessToken ?? env.SQUARE_ACCESS_TOKEN;
  const squareFetch: SandboxFetch = deps.overrides?.square?.fetch ?? ((url, init) => fetch(url, init));
  const locationId = deps.squareLocationId;
  const pay: DemoDeps['pay'] = accessToken && locationId
    ? (input) => sandboxPay({ fetch: squareFetch, accessToken, locationId, environment: env.SQUARE_ENVIRONMENT }, input)
    : undefined;
  deps.log.warn({ demo: 'on', listedNumbers: config.numbers.size, sandboxPayment: pay !== undefined },
    'DEMO MODE IS ON (DEMO_PAY_FIRST): listed numbers get demo messages and a demo pay page before owner approval. Turn it off for real use.');
  return createDemoMode({ config, db: deps.db, message, catalog: deps.catalog, pay, reconcile: deps.reconcile, now: deps.now, log: deps.log, tickMs: deps.overrides?.tickMs });
}
