import type { Bill } from './types';

function escape(value: string | number): string {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);
}
function money(value: number): string {
  const minor = BigInt(value);
  return escape(`$${minor / 100n}.${(minor % 100n).toString().padStart(2, '0')} USD`);
}
/** All dynamic content is text, never markup, attributes, CSS, or URLs. */
export function renderBillHtml(bill: Bill): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Demo bill</title>
<style>body{font-family:system-ui,sans-serif;margin:0;padding:1rem;color:#18202a;background:#f4f5f6}main{max-width:36rem;margin:auto;background:white;padding:1.25rem;border-radius:.5rem}h1{overflow-wrap:anywhere}li{padding:.7rem 0;overflow-wrap:anywhere}.demo{padding:1rem;border:3px solid #18202a;font-weight:bold}dl{display:grid;grid-template-columns:1fr auto;gap:.75rem}dd{margin:0}small{display:block;margin-top:.3rem}.total{font-weight:bold;font-size:1.2rem}</style></head>
<body><main><h1>${escape(bill.businessName)}</h1><p class="demo">Demo bill. Sandbox. No payment is taken.</p>
<ul>${bill.quote.lines.map((line) => `<li>${escape(line.quantity)} &times; ${escape(line.name)}<small>${money(line.lineTotalMinor)}</small>${line.modifiers.map((modifier) => `<small>${escape(modifier.name)}: ${money(modifier.priceMinor)} each</small>`).join('')}</li>`).join('')}</ul>
<dl><dt>Subtotal</dt><dd>${money(bill.quote.subtotalMinor)}</dd><dt>Tax</dt><dd>${money(bill.quote.taxMinor)}</dd><dt class="total">Total</dt><dd class="total">${money(bill.quote.totalMinor)}</dd></dl>
<p>Pickup time: ${escape(bill.pickupAt ?? 'Not scheduled')}</p></main></body></html>`;
}
