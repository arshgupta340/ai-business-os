'use client';

/**
 * The phone line of a stage shop on the scripted demo (NEXT_PUBLIC_DEMO_SCRIPT=1).
 *
 * GET /api/live-agent describes one phone number, the server's configured line. The demo has three shops,
 * each with its own number, so for the barbershop and the salon that answer named the pizza place's number
 * ("Answers the phone number ending 9807", Arsh, 2026-11-15). On the demo build, when the selected
 * business is a stage shop with a number in the settings, the screens are given that shop's own line: its
 * number and its agent. The numbers are the ones the Build screen shows (lib/env.ts). Display only: nothing
 * is sent to the server, and with the flag off the server's answer is used as it is.
 */

import {useMemo} from 'react';
import {stageShopForBusiness} from '@abos/contracts/fixtures';
import {useLiveAgent, type LiveAgent} from '@/lib/api';
import {getDemoPhoneNumberFor, isDemoScript} from '@/lib/env';
import {useBusiness} from '@/lib/session';

/** The stage shop's own line in place of the server's single line, or the server's answer unchanged. */
export function shopLine(live: LiveAgent | undefined, businessId: string | null | undefined): LiveAgent | undefined {
  if (!live || !businessId || !isDemoScript()) return live;
  const shop = stageShopForBusiness(businessId);
  const phoneNumber = shop ? getDemoPhoneNumberFor(shop.key) : undefined;
  if (!shop || !phoneNumber) return live;
  return {phoneNumber, businessId, agentId: shop.agent.id, ...(live.updatedAt ? {updatedAt: live.updatedAt} : {})};
}

/** useLiveAgent(), with the line of the selected stage shop on the scripted demo. */
export function useShopLiveAgent(): ReturnType<typeof useLiveAgent> {
  const query = useLiveAgent();
  const {businessId} = useBusiness();
  const data = useMemo(() => shopLine(query.data, businessId), [query.data, businessId]);
  return data === query.data ? query : ({...query, data} as ReturnType<typeof useLiveAgent>);
}
