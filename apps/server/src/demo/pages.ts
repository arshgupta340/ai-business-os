// D-13 demo pages: the pay page and the tracker. Each is one self-contained HTML document: inline style and
// script, no external script, font or image, mobile first. The Content-Security-Policy the routes send
// lets the page talk only to this server (connect-src 'self') and forbids form submission entirely.
import type { DemoStatus } from './service';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
/** JSON for an inline script: `<` is escaped so no value can close the script element. */
const inlineJson = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export const DEMO_PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data:; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";

const STYLE = `
:root{--bg:#f6f4f1;--card:#fff;--ink:#1d1b19;--muted:#6b645d;--line:#e6e1da;--accent:#c8102e;--ok:#1f7a4d;--warn:#8a5a00;--banner:#fff4d6}
@media (prefers-color-scheme: dark){:root{--bg:#141210;--card:#1f1c19;--ink:#f3efe9;--muted:#a59d94;--line:#36312c;--accent:#ff5a6e;--ok:#5fd39a;--warn:#f1c058;--banner:#3a2f12}}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.banner{background:var(--banner);color:var(--warn);text-align:center;font-weight:600;font-size:14px;padding:10px 16px;border-bottom:1px solid var(--line)}
main{max-width:480px;margin:0 auto;padding:20px 16px 40px}
h1{font-size:22px;margin:4px 0 2px}p{margin:8px 0}.muted{color:var(--muted);font-size:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;margin:16px 0}
.row{display:flex;justify-content:space-between;gap:12px;padding:6px 0}.row span:last-child{white-space:nowrap}
.total{border-top:1px solid var(--line);margin-top:8px;padding-top:10px;font-weight:700}
label{display:block;font-size:14px;color:var(--muted);margin:12px 0 4px}
input{width:100%;font:inherit;padding:12px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--ink)}
button{width:100%;margin-top:18px;font:inherit;font-weight:700;padding:14px;border:0;border-radius:12px;background:var(--accent);color:#fff;cursor:pointer}
button:disabled{opacity:.6;cursor:default}
.state{font-weight:600}.state.ok{color:var(--ok)}.state.bad{color:var(--accent)}
.steps{display:flex;gap:6px;margin:18px 0 8px}.step{flex:1;height:8px;border-radius:4px;background:var(--line)}.step.on{background:var(--accent)}
.labels{display:flex;gap:6px;font-size:13px;color:var(--muted)}.labels span{flex:1}.labels span.on{color:var(--ink);font-weight:600}
`;

function itemsHtml(s: DemoStatus): string {
  const rows = s.items.map((i) => `<div class="row"><span>${i.quantity} x ${esc(i.name)}${i.details ? `<br><span class="muted">${esc(i.details)}</span>` : ''}</span><span>${esc(i.lineTotal)}</span></div>`).join('');
  return `${rows}<div class="row total"><span>Total</span><span>${esc(s.total)}</span></div>`;
}

function page(title: string, body: string, script: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)}</title><style>${STYLE}</style></head><body><div class="banner">Demo: no real money moves</div><main>${body}</main><script>${script}</script></body></html>`;
}

const POLL = `
const poll=(fn)=>{const tick=async()=>{try{const r=await fetch(statusUrl,{cache:'no-store'});if(r.ok)fn(await r.json());}catch(e){}};tick();return setInterval(tick,3000);};
`;

export function payPage(shopName: string, token: string, s: DemoStatus): string {
  // The name-on-card and card number fields are decorative: they have no name attribute, sit in no form,
  // and the script never reads them. Nothing typed in them is ever sent anywhere.
  const body = `<p class="muted">Order for ${esc(s.name)}</p><h1>${esc(shopName)}</h1>
<div class="card">${itemsHtml(s)}</div>
<div class="card" id="payCard"><label for="cardName">Name on card</label><input id="cardName" autocomplete="off" placeholder="Demo only">
<label for="cardNumber">Card number</label><input id="cardNumber" inputmode="numeric" autocomplete="off" placeholder="Demo only: nothing is charged">
<button id="pay" type="button">Pay ${esc(s.total)}</button></div>
<p id="state" class="state" aria-live="polite"></p>`;
  const script = `const token=${inlineJson(token)};const statusUrl='/demo/status/'+token;const trackUrl='/demo/track/'+token;
const st=document.getElementById('state'),btn=document.getElementById('pay'),card=document.getElementById('payCard');let timer;
${POLL}
const show=(s)=>{if(s.stage==='placed'||s.stage==='making'||s.stage==='ready'){location.replace(trackUrl);return;}
if(s.stage==='not_taken'){card.hidden=true;st.className='state bad';st.textContent='Sorry, the shop could not take this order. No money was taken.';clearInterval(timer);return;}
if(s.stage==='reviewing'){card.hidden=true;st.className='state ok';st.textContent='Payment processed (demo). The shop is reviewing your order.';if(!timer)timer=poll(show);}};
btn.addEventListener('click',async()=>{btn.disabled=true;try{const r=await fetch('/demo/pay/'+token,{method:'POST'});if(r.ok)show(await r.json());else btn.disabled=false;}catch(e){btn.disabled=false;}});
show(${inlineJson(s)});`;
  return page(`${shopName} demo payment`, body, script);
}

export function trackPage(shopName: string, token: string, s: DemoStatus): string {
  const body = `<p class="muted">Order for <span id="name">${esc(s.name)}</span></p><h1>${esc(shopName)}</h1>
<div class="card"><p id="headline" class="state"></p><div class="steps"><div class="step" id="s1"></div><div class="step" id="s2"></div><div class="step" id="s3"></div></div>
<div class="labels"><span id="l1">Order placed</span><span id="l2">Being made</span><span id="l3">Ready for pickup</span></div>
<p class="muted" id="ready"></p></div><div class="card">${itemsHtml(s)}</div>`;
  const script = `const token=${inlineJson(token)};const statusUrl='/demo/status/'+token;
const order=['placed','making','ready'];
${POLL}
const show=(s)=>{const n=order.indexOf(s.stage)+1;for(let i=1;i<=3;i++){document.getElementById('s'+i).className='step'+(i<=n?' on':'');document.getElementById('l'+i).className=i===n?'on':'';}
const h=document.getElementById('headline');
h.textContent=s.stage==='ready'?'Your order is ready for pickup.':s.stage==='making'?'Your order is being made.':s.stage==='placed'?'Your order is placed.':s.stage==='not_taken'?'Sorry, the shop could not take this order. No money was taken.':'The shop is reviewing your order.';
document.getElementById('ready').textContent=s.readyTime?'Ready by '+s.readyTime:'';};
show(${inlineJson(s)});poll(show);`;
  return page(`${shopName} order tracker`, body, script);
}
