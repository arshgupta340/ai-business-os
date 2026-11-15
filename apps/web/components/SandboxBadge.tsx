'use client';

/**
 * Place next to any payment data (amounts, order totals, payment links,
 * payment status). Square runs in sandbox only (AGENTS.md rule 4).
 *
 * The label is always shown. It is an outlined chip, not a yellow pill, so it
 * labels the amount without being the loudest thing on the screen
 * (`.abos-sandbox` in app/globals.css).
 */
export function SandboxBadge({label = 'Sandbox'}: {label?: string}) {
  return <span className="abos-sandbox">{label}</span>;
}
