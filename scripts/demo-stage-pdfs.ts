// Writes the six stage files of the demo as HTML, one menu or service list and one FAQ sheet per shop, from
// the stage data (packages/contracts/fixtures/demo-stage.ts). A browser then prints each one to PDF:
//
//   npx tsx scripts/demo-stage-pdfs.ts <out-dir>
//   msedge --headless --no-pdf-header-footer --print-to-pdf=<pdf> <html>     (once per file)
//
// The PDFs in docs/demo/ were made this way. They are attached on the Build screen; only their names are
// read (the name selects the shop). Plain documents, not designed pieces.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STAGE_PIZZA_SIZES, stageShops, type StageShop } from '../packages/contracts/fixtures/demo-stage';

const out = process.argv[2];
if (!out) throw new Error('usage: npx tsx scripts/demo-stage-pdfs.ts <out-dir>');
mkdirSync(out, { recursive: true });

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const dollars = (minor: number) => (minor % 100 === 0 ? `$${minor / 100}` : `$${(minor / 100).toFixed(2)}`);

const CSS = `
  @page { size: Letter; margin: 0.9in; }
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif; color: #1c1c1c; font-size: 12.5pt; line-height: 1.45; margin: 0; }
  header { border-bottom: 2px solid #1c1c1c; padding-bottom: 14px; margin-bottom: 22px; }
  h1 { font-size: 27pt; font-weight: 700; margin: 0 0 4px; letter-spacing: -0.01em; }
  .kind { font-size: 11pt; text-transform: uppercase; letter-spacing: 0.12em; color: #555; margin: 0 0 10px; }
  .meta { color: #333; margin: 0; }
  h2 { font-size: 15pt; margin: 26px 0 10px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 10.5pt; text-transform: uppercase; letter-spacing: 0.08em; color: #555; border-bottom: 1px solid #999; padding: 6px 8px 6px 0; }
  td { border-bottom: 1px solid #ddd; padding: 9px 8px 9px 0; vertical-align: top; }
  td.num, th.num { text-align: right; padding-right: 0; white-space: nowrap; }
  .name { font-weight: 600; }
  .note { color: #555; font-size: 11.5pt; }
  dl { margin: 0; }
  dt { font-weight: 600; margin-top: 16px; }
  dd { margin: 3px 0 0; }
  footer { margin-top: 34px; padding-top: 10px; border-top: 1px solid #ccc; color: #666; font-size: 10pt; }
`;

function page(shop: StageShop, title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(shop.name)} ${esc(title)}</title><style>${CSS}</style></head><body>
<header><p class="kind">${esc(shop.kindLabel)}</p><h1>${esc(shop.name)}</h1><p class="meta">${esc(shop.address)}</p><p class="meta">${esc(shop.hoursText)}</p></header>
${body}
<footer>${esc(shop.name)} is a made-up business for a product demonstration. Prices are test data.</footer>
</body></html>`;
}

function infoPage(shop: StageShop): string {
  if (shop.catalog.length > 0) {
    const sizes = STAGE_PIZZA_SIZES.map((s) => `<tr><td class="name">${esc(s.name)}</td><td>${s.inches} inch</td><td class="num">${dollars(s.priceMinor)}</td></tr>`).join('');
    const pizzas = shop.catalog.map((p) => `<tr><td class="name">${esc(p.name)}</td><td>${esc(p.description ?? '')}</td></tr>`).join('');
    return page(shop, shop.infoTitle, `<h2>Sizes and prices</h2><p class="note">Every pizza costs the same in each size. Prices are before tax.</p>
<table><tr><th>Size</th><th>Diameter</th><th class="num">Price</th></tr>${sizes}</table>
<h2>Pizzas</h2><table><tr><th>Pizza</th><th>What is on it</th></tr>${pizzas}</table>
<h2>Ordering</h2><p>Pickup orders are taken by phone. An order takes about 20 minutes to prepare. Phone orders are for the pizzas as listed.</p>`);
  }
  const rows = shop.services.map((s) => `<tr><td class="name">${esc(s.name)}</td><td>${s.durationMinutes} minutes</td><td class="num">${dollars(s.priceMinor)}</td></tr>`).join('');
  return page(shop, shop.infoTitle, `<h2>Services</h2>
<table><tr><th>Service</th><th>Time</th><th class="num">Price</th></tr>${rows}</table>
<h2>Booking</h2><p>Appointments are booked by phone and need at least one hour of notice. The shop confirms every booking before it is final.</p>`);
}

function faqPage(shop: StageShop): string {
  const items = shop.facts.filter((f) => f.kind === 'faq').map((f) => `<dt>${esc(String(f.value.question))}</dt><dd>${esc(String(f.value.answer))}</dd>`).join('');
  return page(shop, 'Customer questions', `<h2>Customer questions and answers</h2><dl>${items}</dl>`);
}

for (const shop of stageShops) {
  writeFileSync(join(out, shop.files.info.replace(/\.pdf$/i, '.html')), infoPage(shop));
  writeFileSync(join(out, shop.files.faq.replace(/\.pdf$/i, '.html')), faqPage(shop));
  console.log(`${shop.files.info} ${shop.files.faq}`);
}
