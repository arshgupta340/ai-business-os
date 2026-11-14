// D-13 DEMO MODE: the pay-first hackathon demo, built only when demo/config.ts says it is on.
//
// What it does, for a call from a number the owner listed in DEMO_TEXT_NUMBERS:
//   1. propose_menu_message sends the menu once per call by WhatsApp (the Twilio sandbox).
//   2. After propose_order stores a proposal, the server (not the model) sends one demo pay link.
//   3. The demo pay page records demo_paid_at. No money moves and no real order field changes.
//   4. The owner approves in the normal dashboard. The normal executor creates the real Square SANDBOX
//      payment link and the order reaches PAYMENT_PENDING.
//   5. This worker then pays that sandbox order with Square's published sandbox nonce (the same steps as
//      scripts/live/run-demo.ts), and Square's signed webhook and the reconcile poll move the order to
//      PAID_VERIFIED and FULFILLMENT_READY as always. At FULFILLMENT_READY it sends one confirmation with
//      a track link.
// This module never changes an order, an approval, an execution or a dispatch. It writes only the two demo
// tables (migration 0009). It never messages a number that is not listed, and never logs or emits a number.
import { createHash } from 'node:crypto';
import { E164Schema, type CatalogItem } from '@abos/contracts';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { MessageAdapter } from '../adapters/message/index';
import { SANDBOX_NONCE_OK, type SandboxPayInput, type SandboxPayResult } from '../adapters/square/sandbox-pay';
import type { Db } from '../db/index';
import type { SeamDeps } from '../compose/seams';
import type { DemoConfig } from './config';
import { payLink, trackLink, verifyOrderToken } from './links';
import { buildConfirmationMessage, buildMenuMessage, buildPayLinkMessage, dollars, plain, shopTime } from './messages';
import { DEMO_PAGE_CSP, payPage, trackPage } from './pages';
import { demoStage, isNotTaken, type DemoStage } from './stage';

export type DemoMessageKind = 'menu' | 'pay_link' | 'confirmation';
/** What GET /demo/status answers, and nothing more. */
export type DemoStatus = {
  demo: true;
  stage: DemoStage;
  items: { name: string; quantity: number; details: string; lineTotal: string }[];
  total: string;
  name: string;
  readyTime: string | null;
};

export interface DemoDeps {
  config: DemoConfig;
  db: Db;
  /** The Twilio WhatsApp sandbox adapter, whatever MESSAGE_CHANNEL says. */
  message: MessageAdapter;
  catalog: { search(args: { businessId: string; limit: number; signal: AbortSignal }): Promise<CatalogItem[]> };
  /** The shared sandbox payment (adapters/square/sandbox-pay.ts), bound to the Square settings. Absent without them. */
  pay?: ((input: SandboxPayInput) => Promise<SandboxPayResult>) | undefined;
  /** The real read-only reconcile poll, run after a sandbox payment so the order is verified sooner. */
  reconcile?: (() => Promise<unknown>) | undefined;
  now: () => Date;
  log: SeamDeps['log'];
  tickMs?: number | undefined;
}

export type DemoMode = ReturnType<typeof createDemoMode>;

const CALLER_TTL_MS = 3 * 60 * 60 * 1000;
const MAX_PAY_ATTEMPTS = 3;
const MENU_LIMIT = 60;
const ms = (v: unknown) => (v === null || v === undefined ? undefined : new Date(v as string | Date).getTime());

/** The deterministic message row ID and provider idempotency key for one (call or order, kind). */
export function demoMessageKey(scope: string, kind: DemoMessageKind): { id: string; idempotencyKey: string } {
  const hex = createHash('sha256').update(`demo:${scope}:${kind}`).digest('hex');
  return { id: `dmsg_${hex.slice(0, 40)}`, idempotencyKey: hex };
}

export function createDemoMode(deps: DemoDeps) {
  const { config, db, now, log } = deps;
  /** callId -> the listed caller's number, from the signed Twilio webhook. In memory only. */
  const callers = new Map<string, { number: string; at: number }>();
  const pending = new Set<Promise<unknown>>();
  const payAttempts = new Map<string, number>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let ticking: Promise<void> | undefined;

  const track = <T>(p: Promise<T>): Promise<T> => {
    const q = p.finally(() => pending.delete(q));
    pending.add(q);
    return q;
  };

  function listedCaller(from: string | undefined): string | undefined {
    const parsed = E164Schema.safeParse((from ?? '').trim());
    return parsed.success && config.numbers.has(parsed.data) ? parsed.data : undefined;
  }

  function pinCaller(callId: string, number: string): void {
    if (!config.numbers.has(number)) return;
    const t = now().getTime();
    for (const [id, c] of callers) if (t - c.at > CALLER_TTL_MS) callers.delete(id);
    callers.set(callId, { number, at: t });
  }

  /** One demo message, at most once: the row is written before the send and is never sent again. */
  async function sendDemoMessage(m: { scope: string; kind: DemoMessageKind; businessId: string; callId: string | null; recipient: string; body: string }): Promise<'sent' | 'already' | 'not_sent'> {
    if (!config.numbers.has(m.recipient)) return 'not_sent';
    const key = demoMessageKey(m.scope, m.kind);
    const claimed = await db.query(`insert into public.demo_messages (id, business_id, call_id, kind, recipient) values ($1,$2,$3,$4,$5)
      on conflict (id) do nothing returning id`, [key.id, m.businessId, m.callId, m.kind, m.recipient]);
    if (claimed.rows.length === 0) {
      const row = (await db.query('select sent_at from public.demo_messages where id = $1', [key.id])).rows[0] as { sent_at: unknown } | undefined;
      return row?.sent_at ? 'already' : 'not_sent';
    }
    let result: Awaited<ReturnType<MessageAdapter['send']>>;
    try { result = await deps.message.send({ to: m.recipient, body: m.body, idempotencyKey: key.idempotencyKey }); }
    catch { result = { status: 'UNKNOWN' }; }
    if (result.status === 'SENT') {
      await db.query('update public.demo_messages set sent_at = $2, provider_ref = $3 where id = $1', [key.id, now(), result.providerMessageId ?? null]);
      log.info({ demo: true, kind: m.kind }, 'demo: message sent');
      return 'sent';
    }
    log.warn({ demo: true, kind: m.kind, status: result.status }, 'demo: message not sent; it will not be retried');
    return 'not_sent';
  }

  async function businessName(businessId: string): Promise<string> {
    const row = (await db.query('select name from public.businesses where id = $1', [businessId])).rows[0] as { name: string } | undefined;
    return row?.name ?? 'The shop';
  }

  /** propose_menu_message for one call. */
  async function sendMenu(input: { callId: string; businessId: string; signal: AbortSignal }): Promise<{ sent: boolean }> {
    const caller = callers.get(input.callId);
    if (caller === undefined) return { sent: false };
    const items = (await deps.catalog.search({ businessId: input.businessId, limit: MENU_LIMIT, signal: input.signal })).filter((i) => i.businessId === input.businessId);
    const body = buildMenuMessage(await businessName(input.businessId), items);
    const r = await sendDemoMessage({ scope: input.callId, kind: 'menu', businessId: input.businessId, callId: input.callId, recipient: caller.number, body });
    return { sent: r !== 'not_sent' };
  }

  async function sendPayLink(callId: string, businessId: string, orderId: string, recipient: string): Promise<void> {
    const order = (await db.query(`select o.total_minor, b.name from public.orders o join public.businesses b on b.id = o.business_id
      where o.id = $1 and o.business_id = $2 and o.call_id = $3`, [orderId, businessId, callId])).rows[0] as { total_minor: number; name: string } | undefined;
    if (!order) return;
    await db.query('insert into public.demo_orders (order_id, business_id, recipient) values ($1,$2,$3) on conflict (order_id) do nothing', [orderId, businessId, recipient]);
    const body = buildPayLinkMessage(order.name, Number(order.total_minor), payLink(config.publicUrl, orderId, config.secret));
    const r = await sendDemoMessage({ scope: orderId, kind: 'pay_link', businessId, callId, recipient, body });
    if (r !== 'not_sent') await db.query('update public.demo_orders set link_sent_at = coalesce(link_sent_at, $2) where order_id = $1', [orderId, now()]);
  }

  /** After propose_order stored a proposal on a demo call. Never throws; the tool result is not changed. */
  function orderProposed(input: { callId: string; businessId: string; orderId: string }): void {
    const caller = callers.get(input.callId);
    if (caller === undefined) return;
    void track(sendPayLink(input.callId, input.businessId, input.orderId, caller.number).catch((e: unknown) =>
      log.error({ demo: true, orderId: input.orderId, code: e instanceof Error ? e.name : 'unknown' }, 'demo: pay link failed')));
  }

  async function readStatus(orderId: string): Promise<{ status: DemoStatus; shopName: string } | undefined> {
    const r = (await db.query(`select d.demo_paid_at, d.confirmation_sent_at, o.status, o.quote, o.total_minor, o.contact, o.fulfillment, b.name, b.timezone
      from public.demo_orders d join public.orders o on o.id = d.order_id join public.businesses b on b.id = d.business_id where d.order_id = $1`, [orderId])).rows[0] as Record<string, unknown> | undefined;
    if (!r) return undefined;
    const quote = (r.quote ?? {}) as { lines?: { name?: string; quantity?: number; lineTotalMinor?: number; modifiers?: { name?: string }[] }[] };
    const pickupAt = String((r.fulfillment as { pickupAt?: string } | null)?.pickupAt ?? '');
    const confirmedAtMs = ms(r.confirmation_sent_at);
    const stage = demoStage({ orderStatus: String(r.status), demoPaidAtMs: ms(r.demo_paid_at), confirmedAtMs, pickupAtMs: Date.parse(pickupAt),
      nowMs: now().getTime(), makingAfterMs: config.makingAfterMs, readyAfterMs: config.readyAfterMs, pickupFarMs: config.pickupFarMs });
    return {
      shopName: plain(String(r.name)),
      status: {
        demo: true,
        stage,
        items: (quote.lines ?? []).map((l) => ({ name: plain(String(l.name ?? 'Item')), quantity: Number(l.quantity ?? 1),
          details: (l.modifiers ?? []).map((m) => plain(String(m.name ?? ''))).filter(Boolean).join(', '), lineTotal: dollars(Number(l.lineTotalMinor ?? 0)) })),
        total: dollars(Number(r.total_minor)),
        name: plain(String((r.contact as { name?: string } | null)?.name ?? '')),
        readyTime: confirmedAtMs !== undefined && pickupAt ? shopTime(pickupAt, String(r.timezone)) : null,
      },
    };
  }

  /** The demo pay button. Sets demo_paid_at once; writes nothing to the real order. */
  async function markPaid(orderId: string): Promise<void> {
    const r = (await db.query('select o.status from public.demo_orders d join public.orders o on o.id = d.order_id where d.order_id = $1', [orderId])).rows[0] as { status: string } | undefined;
    if (!r || isNotTaken(r.status)) return;
    await db.query('update public.demo_orders set demo_paid_at = coalesce(demo_paid_at, $2) where order_id = $1', [orderId, now()]);
  }

  type DueRow = { order_id: string; business_id: string; recipient: string; sandbox_payment_id: string | null; status: string; square_order_id: string | null;
    total_minor: number; currency: string; fulfillment: { pickupAt?: string } | null; approval_state: string | null; name: string; timezone: string };

  async function tickOnce(): Promise<void> {
    const due = (await db.query(`select d.order_id, d.business_id, d.recipient, d.sandbox_payment_id, o.status, o.square_order_id, o.total_minor, o.currency,
        o.fulfillment, a.state as approval_state, b.name, b.timezone
      from public.demo_orders d join public.orders o on o.id = d.order_id join public.businesses b on b.id = d.business_id
      left join public.approval_requests a on a.id = o.approval_id
      where d.demo_paid_at is not null and d.confirmation_sent_at is null order by d.created_at limit 20`, [])).rows as DueRow[];
    let paid = false;
    for (const row of due) {
      try {
        // The sandbox payment, only for an order the owner approved (the engine's APPROVED approval) whose demo
        // payment was made, once the real executor reached PAYMENT_PENDING with a Square order.
        if (row.status === 'PAYMENT_PENDING' && row.approval_state === 'APPROVED' && row.square_order_id && !row.sandbox_payment_id && deps.pay) {
          const tries = payAttempts.get(row.order_id) ?? 0;
          if (tries >= MAX_PAY_ATTEMPTS) continue;
          payAttempts.set(row.order_id, tries + 1);
          const r = await deps.pay({ orderId: row.order_id, squareOrderId: row.square_order_id, totalMinor: Number(row.total_minor), currency: row.currency,
            nonce: SANDBOX_NONCE_OK, attempt: 'demo' });
          const paymentId = typeof r.payment?.id === 'string' ? r.payment.id : undefined;
          if (r.httpOk && paymentId) {
            await db.query('update public.demo_orders set sandbox_payment_id = $2 where order_id = $1 and sandbox_payment_id is null', [row.order_id, paymentId]);
            log.info({ demo: true, orderId: row.order_id }, 'demo: SIMULATED sandbox payment made; waiting for Square to confirm it');
            paid = true;
          } else log.warn({ demo: true, orderId: row.order_id }, 'demo: SIMULATED sandbox payment refused');
        }
        if (row.status === 'FULFILLMENT_READY') {
          const pickupAt = row.fulfillment?.pickupAt;
          const ready = pickupAt ? shopTime(pickupAt, row.timezone) : 'pickup';
          const body = buildConfirmationMessage(row.name, ready, trackLink(config.publicUrl, row.order_id, config.secret));
          const r = await sendDemoMessage({ scope: row.order_id, kind: 'confirmation', businessId: row.business_id, callId: null, recipient: row.recipient, body });
          if (r !== 'not_sent') await db.query('update public.demo_orders set confirmation_sent_at = coalesce(confirmation_sent_at, $2) where order_id = $1', [row.order_id, now()]);
        }
      } catch (e) {
        log.error({ demo: true, orderId: row.order_id, code: e instanceof Error ? e.name : 'unknown' }, 'demo: worker step failed');
      }
    }
    if (paid && deps.reconcile) await deps.reconcile().catch(() => log.warn({ demo: true }, 'demo: reconcile after the sandbox payment failed'));
  }

  function tick(): Promise<void> {
    ticking ??= tickOnce().finally(() => { ticking = undefined; });
    return ticking;
  }

  const reply404 = (reply: FastifyReply) => reply.code(404).type('text/plain; charset=utf-8').header('Cache-Control', 'no-store').send('Not found.');
  const headers = (reply: FastifyReply) => reply
    .header('Content-Security-Policy', DEMO_PAGE_CSP).header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer')
    .header('X-Content-Type-Options', 'nosniff').header('X-Robots-Tag', 'noindex');

  const routes: FastifyPluginAsync = async (scope) => {
    // The body of a demo request is never read: no parser runs, whatever it claims to carry.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', (_request, _payload, done) => done(null, undefined));
    const opts = { config: { auth: 'public' as const }, logLevel: 'silent' as const };
    const order = (token: unknown) => verifyOrderToken(token, config.secret);
    scope.get('/demo/pay/:token', opts, async (request, reply) => {
      const token = (request.params as { token?: string }).token;
      const id = order(token); const s = id ? await readStatus(id) : undefined;
      if (!s) return reply404(reply);
      return headers(reply).type('text/html; charset=utf-8').send(payPage(s.shopName, token!, s.status));
    });
    scope.post('/demo/pay/:token', opts, async (request, reply) => {
      const id = order((request.params as { token?: string }).token);
      if (!id || !(await readStatus(id))) return reply404(reply);
      await markPaid(id);
      return headers(reply).send((await readStatus(id))!.status);
    });
    scope.get('/demo/track/:token', opts, async (request, reply) => {
      const token = (request.params as { token?: string }).token;
      const id = order(token); const s = id ? await readStatus(id) : undefined;
      if (!s) return reply404(reply);
      return headers(reply).type('text/html; charset=utf-8').send(trackPage(s.shopName, token!, s.status));
    });
    scope.get('/demo/status/:token', opts, async (request, reply) => {
      const id = order((request.params as { token?: string }).token);
      const s = id ? await readStatus(id) : undefined;
      if (!s) return reply404(reply);
      return headers(reply).send(s.status);
    });
  };

  return {
    config,
    routes,
    listedCaller,
    pinCaller,
    release(callId: string) { callers.delete(callId); },
    hasCaller(callId: string) { return callers.has(callId); },
    /** The toolset port for one call (tools/real MenuMessagePort). */
    menuPort(businessId: string) {
      return { send: (args: { callId: string; signal: AbortSignal }) => track(sendMenu({ ...args, businessId })) };
    },
    orderProposed,
    readStatus,
    markPaid,
    tick,
    start() {
      if (timer) return;
      timer = setInterval(() => { void tick().catch(() => undefined); }, deps.tickMs ?? 3000);
      (timer as { unref?: () => void }).unref?.();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      await ticking?.catch(() => undefined);
      await Promise.allSettled([...pending]);
    },
    /** Waits for every demo send started so far (tests). */
    async idle() { await Promise.allSettled([...pending]); await ticking?.catch(() => undefined); },
  };
}

