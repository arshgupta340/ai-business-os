// Builds the adapter for a resolved channel configuration.

import type { InspectableAdapter } from "./adapter.ts";
import { AndroidGatewayAdapter } from "./android-gateway.ts";
import type { ChannelConfig } from "./env.ts";
import type { FetchLike } from "./http.ts";
import { SurgeAdapter } from "./surge.ts";
import { WhatsAppSandboxAdapter } from "./whatsapp-sandbox.ts";

export function createAdapter(config: ChannelConfig, fetchImpl?: FetchLike): InspectableAdapter {
  switch (config.channel) {
    case "surge":
      return new SurgeAdapter(config, fetchImpl);
    case "android_gateway":
      return new AndroidGatewayAdapter(config, fetchImpl);
    case "whatsapp_sandbox":
      return new WhatsAppSandboxAdapter(config, fetchImpl);
  }
}

/** Checkout message wording, template checkout_link, from docs/FLOWS.md step B21. */
export function checkoutMessage(url: string): string {
  return `Demo Pizza Co.: pay for your pickup order here: ${url}. Sandbox test payment.`;
}
