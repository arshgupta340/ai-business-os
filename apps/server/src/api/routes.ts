import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  ENDPOINTS, ErrorCodeSchema, PaginationQuerySchema, canonicalJson, type EndpointDefinition, type EndpointName,
  type CatalogItem, ProposeFactBodySchema, ApprovalDecisionSchema, UpdateBusinessBodySchema,
} from '@abos/contracts';
import type { Db } from '../db/index';
import type { Env } from '../env';
import { AppError } from '../errors';
import { errorMessage } from '../error-messages';
import { PolicyError } from '../policy/types';
import { mapApprovalRow, mapRow } from './rows';
import { ownerDisplayNames, withApprovalDisplayFields } from './display';
import { setLiveAgent } from './live-agent';
import { unavailableCatalog, type CatalogPort, type EnginePorts } from './ports';
import { createHealthMonitor, type HealthMonitor } from '../compose/health';
import { createReplayCache } from './replay';
export { setLiveAgent } from './live-agent';

export type ProviderStatusMap = Record<'square' | 'twilio' | 'openai' | 'google_calendar' | 'google_sheets' | 'message_channel', { configured: boolean; detail: string; noProviderNeeded?: true }>;
export interface ApiDependencies { db: Db; ports: EnginePorts; env: Env; catalog?: CatalogPort; providerStatus?: ProviderStatusMap; health?: HealthMonitor }
export const CORE_ENDPOINTS = Object.entries(ENDPOINTS).filter(([name, e]) =>
  e.owner === 'arsh' && e.tier === 'MUST' && name !== 'simCall') as [EndpointName, EndpointDefinition][];

function validate(schema: z.ZodType | undefined, value: unknown): unknown {
  if (!schema) return value;
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', 'Request validation failed.', undefined, undefined, {
    issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.code === 'unrecognized_keys' ? 'Unknown field.' : 'Invalid value.' })),
  });
  return parsed.data;
}
const object = (value: unknown) => value as Record<string, unknown>;
const notFound = () => new AppError('NOT_FOUND', 'Resource was not found in this business.');

// All identifiers below come from this static map, never from request input.
const collections = {
  listApprovals: { table: 'approval_requests', time: 'created_at' },
  listOrders: { table: 'orders', time: 'created_at' },
  listBookings: { table: 'bookings', time: 'created_at' },
  listCalls: { table: 'calls', time: 'started_at' },
  listActivity: { table: 'activity_events', time: 'occurred_at' },
} as const;
const singles = { getApproval: 'approval_requests', getOrder: 'orders', getBooking: 'bookings', getCall: 'calls' } as const;
const CursorSchema = z.object({ id: z.string().min(1), time: z.iso.datetime(), scope: z.string() });
const OffsetCursorSchema = z.object({ offset: z.int().min(0), scope: z.string() });

/** These three small reference lists have no pagination fields in the endpoint table yet. */
function referencePage(items: unknown[], query: Record<string, unknown>, scope: string) {
  let offset = 0;
  if (query.cursor !== undefined) {
    try {
      const cursor = OffsetCursorSchema.parse(JSON.parse(Buffer.from(String(query.cursor), 'base64url').toString('utf8')));
      if (cursor.scope !== scope) throw new Error('Wrong cursor scope');
      offset = cursor.offset;
    } catch { throw new AppError('VALIDATION_FAILED', 'Invalid pagination cursor.'); }
  }
  const limit = typeof query.limit === 'number' ? query.limit : 50;
  return { items: items.slice(offset, offset + limit), ...(offset + limit < items.length ? {
    nextCursor: Buffer.from(JSON.stringify({ offset: offset + limit, scope })).toString('base64url'),
  } : {}) };
}

async function list(db: Db, name: keyof typeof collections, businessId: string, query: Record<string, unknown>) {
  const { table, time } = collections[name];
  const values: unknown[] = [businessId];
  const clauses = ['business_id = $1'];
  function filter(column: string, operator: string, value: unknown, cast = '') {
    if (value === undefined) return;
    values.push(value);
    clauses.push(`${column} ${operator} $${values.length}${cast}`);
  }
  if (name === 'listApprovals') {
    filter('state', '=', query.state ?? 'PENDING');
    filter('bundle_type', '=', query.bundleType);
  }
  if (name === 'listOrders' || name === 'listBookings') {
    if (Array.isArray(query.status)) filter('status', '= ANY(', query.status, '::text[])');
  }
  if (name === 'listOrders') filter('call_id', '=', query.callId);
  if (name === 'listBookings') {
    filter('start_utc', '>=', query.from);
    filter('start_utc', '<=', query.to);
  }
  if (name === 'listCalls') {
    filter('agent_id', '=', query.agentId);
    filter('started_at', '>=', query.since);
  }
  if (name === 'listActivity') {
    if (Array.isArray(query.types)) filter('type', '= ANY(', query.types, '::text[])');
    filter('correlation_id', '=', query.correlationId);
    filter('occurred_at', '>=', query.since);
  }
  const scope = createHash('sha256').update(canonicalJson({ name, businessId, ...query, cursor: undefined, limit: undefined })).digest('hex');
  if (query.cursor !== undefined) {
    let cursor: z.infer<typeof CursorSchema>;
    try { cursor = CursorSchema.parse(JSON.parse(Buffer.from(String(query.cursor), 'base64url').toString('utf8'))); }
    catch { throw new AppError('VALIDATION_FAILED', 'Invalid pagination cursor.'); }
    if (cursor.scope !== scope) throw new AppError('VALIDATION_FAILED', 'Cursor does not belong to this query.');
    values.push(cursor.time, cursor.id);
    clauses.push(`(${time}, id) < ($${values.length - 1}::timestamptz, $${values.length}::text)`);
  }
  const limit = typeof query.limit === 'number' ? query.limit : 50;
  values.push(limit + 1);
  const rows = (await db.query(`select *, to_char(${time} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as page_time
    from public.${table} where ${clauses.join(' and ')} order by ${time} desc, id desc limit $${values.length}`, values)).rows;
  const mapped = rows.slice(0, limit).map(name === 'listApprovals' ? mapApprovalRow : mapRow);
  const page = name === 'listActivity' ? await normalizeActivity(db, mapped)
    : name === 'listApprovals' ? await withApprovalDisplayFields(db, businessId, mapped) : mapped;
  const last = page.at(-1);
  return { items: page, ...(rows.length > limit && last ? {
    nextCursor: Buffer.from(JSON.stringify({ id: last.id, time: last.pageTime, scope })).toString('base64url'),
  } : {}) };
}

async function one(db: Db, table: string, id: string, businessId: string) {
  const row = (await db.query(`select * from public.${table} where id = $1 and business_id = $2`, [id, businessId])).rows[0];
  if (!row) throw notFound();
  return table === 'approval_requests' ? mapApprovalRow(row) : mapRow(row);
}

async function catalog(db: Db, businessId: string) {
  const rows = (await db.query('select * from public.catalog_items where business_id = $1 order by square_item_id, square_variation_id', [businessId])).rows.map(mapRow);
  const grouped = new Map<string, CatalogItem>();
  for (const row of rows) {
    const id = String(row.squareItemId);
    const existing = grouped.get(id);
    const variation = { id: String(row.squareVariationId), name: String(row.variationName), priceMinor: Number(row.priceMinor), currency: 'USD' as const };
    if (existing) {
      existing.variations.push(variation);
      existing.available ||= row.isAvailable === true;
      if (String(row.syncedAt) > existing.syncedAt) existing.syncedAt = String(row.syncedAt);
    } else {
      grouped.set(id, { squareItemId: id, businessId, name: String(row.itemName),
        ...(row.description === undefined ? {} : { description: String(row.description) }), available: row.isAvailable === true,
        variations: [variation], modifierLists: row.modifierLists as CatalogItem['modifierLists'], syncedAt: String(row.syncedAt) });
    }
  }
  return { items: [...grouped.values()], syncedAt: rows.reduce((latest, row) => String(row.syncedAt) > latest ? String(row.syncedAt) : latest, new Date(0).toISOString()) };
}

/**
 * API 3.11. Reports whether each provider is configured and its client was built at startup
 * (compose/providers.ts). It makes no live provider call, so `connected` means "configured and
 * usable" only after a read-only probe confirmed access (compose/health.ts); `refresh=1` runs the probes.
 */
async function health(env: Env, monitor: HealthMonitor, refresh: boolean) {
  const report = await monitor.read({ refresh });
  const entry = (k: keyof ProviderStatusMap) => ({ state: report[k].state, detail: report[k].detail, lastCheckedAt: report[k].lastCheckedAt });
  return {
    square: { ...entry('square'), environment: 'sandbox' },
    twilio: entry('twilio'), openai: entry('openai'), google_calendar: entry('google_calendar'), google_sheets: entry('google_sheets'),
    message_channel: { ...entry('message_channel'), ...(env.MESSAGE_CHANNEL ? { channel: env.MESSAGE_CHANNEL } : {}) },
  };
}

/** Configuration from the environment alone, for an app built without the composed provider status. */
function envStatus(env: Env): ProviderStatusMap {
  const fromEnv: ProviderStatusMap = {
    square: { configured: Boolean(env.SQUARE_ACCESS_TOKEN && env.SQUARE_LOCATION_ID), detail: '' },
    twilio: { configured: Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_PHONE_NUMBER), detail: '' },
    openai: { configured: Boolean(env.OPENAI_API_KEY), detail: '' },
    google_calendar: { configured: Boolean(env.GOOGLE_SERVICE_ACCOUNT_JSON && env.GOOGLE_CALENDAR_ID), detail: '' },
    google_sheets: { configured: Boolean(env.GOOGLE_SERVICE_ACCOUNT_JSON && env.GOOGLE_SHEET_ID), detail: '' },
    message_channel: env.MESSAGE_CHANNEL === 'qr_only' ? { configured: true, detail: 'qr_only sends nothing', noProviderNeeded: true } : { configured: false, detail: 'not checked' },
  };
  for (const s of Object.values(fromEnv)) if (!s.detail) s.detail = s.configured ? 'configured' : 'unconfigured';
  return fromEnv;
}

/**
 * The decision and expiry routines write their own order.status_changed and booking.status_changed
 * rows with `{ subjectId, from, to }` (migration 0004), while the contract payload names the subject
 * `orderId` or `bookingId` and requires `callId` for orders. Fill those from the subject at read time,
 * so the audit list stays valid without rewriting append-only rows.
 */
export async function normalizeActivity(db: Db, items: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
  const kindOf = (item: Record<string, unknown>) => {
    const payload = item.payload as Record<string, unknown> | undefined;
    const kind = item.type === 'order.status_changed' ? 'orders' as const : item.type === 'booking.status_changed' ? 'bookings' as const : undefined;
    if (!kind || !payload || typeof payload.subjectId !== 'string' || payload.orderId !== undefined || payload.bookingId !== undefined) return undefined;
    return { kind, payload, subjectId: payload.subjectId, businessId: String(item.businessId) };
  };
  // One batched lookup per subject table (review finding 9), keyed by business and subject, so an
  // event never borrows a call from another business's row.
  const wanted = { orders: new Map<string, [string, string]>(), bookings: new Map<string, [string, string]>() };
  for (const item of items) {
    const k = kindOf(item);
    if (k) wanted[k.kind].set(`${k.businessId}\u0000${k.subjectId}`, [k.businessId, k.subjectId]);
  }
  const calls = { orders: new Map<string, string>(), bookings: new Map<string, string>() };
  for (const kind of ['orders', 'bookings'] as const) {
    const pairs = [...wanted[kind].values()];
    if (pairs.length === 0) continue;
    const rows = (await db.query(`select s.business_id, s.id, s.call_id from public.${kind} s
      join unnest($1::text[], $2::text[]) as w(business_id, id) on w.business_id = s.business_id and w.id = s.id`,
    [pairs.map((p) => p[0]), pairs.map((p) => p[1])])).rows as { business_id: string; id: string; call_id: string | null }[];
    for (const r of rows) if (r.call_id) calls[kind].set(`${r.business_id}\u0000${r.id}`, r.call_id);
  }
  return items.map((item) => {
    const k = kindOf(item);
    if (!k) return item;
    const { subjectId, ...rest } = k.payload;
    const callId = calls[k.kind].get(`${k.businessId}\u0000${k.subjectId}`);
    return { ...item, payload: { ...rest, ...(k.kind === 'orders' ? { orderId: subjectId } : { bookingId: subjectId }), ...(callId ? { callId } : {}) } };
  });
}

/** API.md section 1: a decision's first response is replayed for 24 hours. At most this many keys are held. */
const REPLAY_TTL_MS = 86_400_000;
const REPLAY_MAX_ENTRIES = 1000;

export async function apiRoutes(app: FastifyInstance, deps: ApiDependencies): Promise<void> {
  const { db, ports, env } = deps;
  const replays = createReplayCache<Promise<unknown>>({ ttlMs: REPLAY_TTL_MS, maxEntries: REPLAY_MAX_ENTRIES });
  const healthMonitor = deps.health ?? createHealthMonitor({ status: deps.providerStatus ?? envStatus(env), probes: {}, now: () => new Date() });
  async function execute(name: EndpointName, request: FastifyRequest, params: Record<string, unknown>, query: Record<string, unknown>, body: unknown): Promise<unknown> {
    const ownerUserId = request.ownerUserId;
    const businessId = request.businessId ?? '';
    const id = String(params.id ?? '');
    if (name in collections) return list(db, name as keyof typeof collections, businessId, query);
    if (name === 'getApproval') return (await withApprovalDisplayFields(db, businessId, [await one(db, singles.getApproval, id, businessId)]))[0];
    if (name in singles) return one(db, singles[name as keyof typeof singles], id, businessId);
    switch (name) {
      case 'listBusinesses': return referencePage((await db.query('select * from public.businesses where owner_id = $1 order by id', [ownerUserId])).rows.map(mapRow), query, canonicalJson({ name, ownerUserId }));
      case 'getBusiness': {
        const row = (await db.query('select * from public.businesses where id = $1 and owner_id = $2', [id, ownerUserId])).rows[0];
        if (!row) throw notFound();
        return mapRow(row);
      }
      case 'updateBusiness': {
        const update = UpdateBusinessBodySchema.parse(body);
        const row = (await db.query(`update public.businesses set name = coalesce($3, name), contact = coalesce($4::jsonb, contact),
          settings = coalesce($5::jsonb, settings) where id = $1 and owner_id = $2 returning *`,
          [id, ownerUserId, update.name ?? null, update.contact === undefined ? null : JSON.stringify(update.contact),
            update.settings === undefined ? null : JSON.stringify(update.settings)])).rows[0];
        if (!row) throw notFound();
        return mapRow(row);
      }
      case 'listFacts': {
        const facts = await db.query(`select * from public.business_facts where business_id = $1
          and ($2::text is null or kind = $2) and (($3::text is null and status <> 'superseded') or status = $3) order by kind, key, version desc, id`,
          [businessId, query.kind ?? null, query.status ?? null]);
        const conflicts = await db.query("select * from public.fact_conflicts where business_id = $1 and state = 'open' and ($2::text is null or kind = $2) order by id", [businessId, query.kind ?? null]);
        return { ...referencePage(facts.rows.map(mapRow), query, canonicalJson({ name, businessId, kind: query.kind, status: query.status })), conflicts: conflicts.rows.map(mapRow) };
      }
      case 'proposeFact': {
        const proposal = ProposeFactBodySchema.parse(body);
        if ('resolvesConflictId' in proposal) {
          const conflict = await one(db, 'fact_conflicts', proposal.resolvesConflictId, businessId);
          if (conflict.state !== 'open') throw new AppError('INVALID_STATE', 'Conflict is already resolved.');
          // A Square price is not a fact edit, and a price approval cannot link to a conflict yet (CONTRACTS section 12).
          if (conflict.kind === 'menu_item') {
            throw new AppError('CAPABILITY_NOT_ALLOWED', 'A Square price is changed with a price change. Change the price, sync, then keep the current value on this conflict.', undefined, false,
              { use: ['POST /api/businesses/:id/catalog/prices/propose', 'POST /api/conflicts/:id/resolve with resolution keep_authoritative'] });
          }
          const kept = (await db.query("select value from public.business_facts where business_id = $1 and kind = $2 and key = $3 and status = 'verified'",
            [businessId, conflict.kind, conflict.key])).rows[0] as { value: unknown } | undefined;
          if (kept && canonicalJson(kept.value) === canonicalJson(proposal.value)) {
            throw new AppError('VALIDATION_FAILED', 'This is the current value. Keep it on the conflict instead of proposing it.', undefined, false,
              { use: 'POST /api/conflicts/:id/resolve with resolution keep_authoritative' });
          }
          const input = { ...proposal, kind: conflict.kind, key: conflict.key };
          const normalized = ProposeFactBodySchema.options[0].parse({ kind: input.kind, key: input.key, value: input.value, reason: input.reason });
          return { approval: (await ports.proposeFactEdit({ ...normalized, resolvesConflictId: proposal.resolvesConflictId, businessId, ownerUserId })).approval };
        }
        return { approval: (await ports.proposeFactEdit({ ...proposal, businessId, ownerUserId })).approval };
      }
      case 'getCatalog': {
        const result = await catalog(db, businessId);
        return { ...result, ...referencePage(result.items, query, canonicalJson({ name, businessId })) };
      }
      case 'syncCatalog': return (deps.catalog ?? unavailableCatalog).sync({ businessId, ownerUserId });
      case 'decideApproval': {
        await one(db, 'approval_requests', id, businessId);
        const input = ApprovalDecisionSchema.parse(body);
        const perform = async () => {
          const { approval } = await ports.decide({ ...input, approvalId: id, businessId, ownerUserId });
          // Issue #108: the decider's display name, read after the decision is recorded. Display only,
          // so a failed lookup sends no name: it must not turn a recorded decision into an error.
          const decidedByName = approval.decidedBy
            ? (await ownerDisplayNames(db, businessId, [approval.decidedBy]).catch(() => new Map<string, string>())).get(approval.decidedBy) : undefined;
          return { approval: { ...approval, ...(decidedByName ? { decidedByName } : {}) } };
        };
        const key = request.headers['idempotency-key'];
        if (typeof key !== 'string') return perform();
        const cacheKey = canonicalJson({ ownerUserId, key });
        const fingerprint = canonicalJson({ id, businessId, body: request.body });
        // Held in this process only (api/replay.ts). After a restart the repeat reaches the engine, where an
        // identical decision is recorded once by the database and answers 200 with the current approval.
        const previous = replays.get(cacheKey);
        if (previous) {
          if (previous.fingerprint !== fingerprint) throw new AppError('VALIDATION_FAILED', 'Idempotency key was already used for another request.');
          return previous.response;
        }
        const response = perform().then((value) => {
          const parsed = ENDPOINTS.decideApproval.response.safeParse(value);
          if (!parsed.success) throw new AppError('INTERNAL', 'Approval engine returned an invalid response.');
          return parsed.data;
        });
        replays.set(cacheKey, { fingerprint, response });
        try { return await response; } catch (error) { replays.delete(cacheKey); throw error; }
      }
      case 'getOrderCheckout': {
        const order = await one(db, 'orders', id, businessId);
        const messages = await db.query('select * from public.message_dispatches where business_id = $1 and order_id = $2 order by created_at desc, id desc limit 1', [businessId, id]);
        const message = messages.rows[0] ? mapRow(messages.rows[0]) : undefined;
        // Fail closed (FLOWS 4): a dispatch still QUEUED whose step is no longer running (a worker died in
        // the send and stale recovery sent the step to review) may have been sent. The row cannot be
        // corrected: update_dispatch needs the step's live lease and update_dispatch_status takes only
        // SENT, DELIVERED or FAILED. Show it as UNKNOWN rather than as waiting to be sent.
        if (message && message.status === 'QUEUED' && typeof message.executionId === 'string') {
          const step = (await db.query('select status from public.action_executions where id = $1 and business_id = $2', [message.executionId, businessId])).rows[0] as { status?: string } | undefined;
          if (step?.status !== 'RUNNING' && step?.status !== 'QUEUED') message.status = 'UNKNOWN';
        }
        const ready = typeof order.checkoutUrl === 'string' && typeof order.squarePaymentLinkId === 'string' && typeof order.squareOrderId === 'string';
        return { orderId: id, ready, environment: 'sandbox', ...(ready ? { checkoutUrl: order.checkoutUrl, qrText: order.checkoutUrl, squarePaymentLinkId: order.squarePaymentLinkId } : {}), ...(message ? { message } : {}) };
      }
      case 'getIntegrationsHealth': return health(env, healthMonitor, query.refresh === '1');
      case 'getLiveAgent': {
        if (!env.TWILIO_PHONE_NUMBER) throw new AppError('INTEGRATION_UNAVAILABLE', 'Phone number is not configured.');
        const rows = await db.query(`select l.* from public.live_agent l join public.businesses b on b.id = l.business_id
          where l.phone_number = $1 and b.owner_id = $2`, [env.TWILIO_PHONE_NUMBER, ownerUserId]);
        if (rows.rows[0]) return mapRow(rows.rows[0]);
        const business = (await db.query('select * from public.businesses where owner_id = $1 order by id limit 1', [ownerUserId])).rows[0];
        if (!business) throw notFound();
        const fallback = mapRow(business);
        return { phoneNumber: env.TWILIO_PHONE_NUMBER, businessId: fallback.id, updatedAt: fallback.updatedAt };
      }
      case 'putLiveAgent': {
        if (!env.TWILIO_PHONE_NUMBER) throw new AppError('INTEGRATION_UNAVAILABLE', 'Phone number is not configured.');
        return setLiveAgent(db, { agentId: String(object(body).agentId), ownerUserId, phoneNumber: env.TWILIO_PHONE_NUMBER, correlationId: request.correlationId });
      }
      default: throw new AppError('INTERNAL', 'Route is not implemented.');
    }
  }
  for (const [name, endpoint] of CORE_ENDPOINTS) {
    app.route({ method: endpoint.method, url: endpoint.path, async handler(request, reply) {
      const params = object(validate(endpoint.params, request.params) ?? {});
      const referenceList = name === 'listBusinesses' || name === 'listFacts' || name === 'getCatalog';
      const query = { ...object(validate(endpoint.query, request.query) ?? {}),
        ...(referenceList ? object(validate(PaginationQuerySchema, request.query)) : {}) };
      validate(endpoint.headers, request.headers);
      const body = validate(endpoint.body, request.body);
      let value: unknown;
      try { value = await execute(name, request, params, query, body); }
      catch (error) {
        if (error instanceof AppError) throw error;
        const code = ErrorCodeSchema.safeParse(error && typeof error === 'object' && 'code' in error ? error.code : undefined);
        // A PolicyError's message is the server's own sentence. Any other error's message may carry a provider
        // response, so it is replaced by the plain sentence for its code (issue #127).
        if (code.success) throw new AppError(code.data, error instanceof PolicyError ? error.message : errorMessage(code.data));
        throw error;
      }
      const response = endpoint.response.safeParse(value);
      if (!response.success) {
        request.log.error({ route: name, issues: response.error.issues.map((issue) => ({ path: issue.path, code: issue.code })) }, 'Response failed contract validation');
        throw new AppError('INTERNAL', 'Response validation failed.');
      }
      const nextCursor = referenceList ? object(value).nextCursor : undefined;
      return reply.status(endpoint.successStatus).send({ ...object(response.data),
        ...(typeof nextCursor === 'string' ? { nextCursor } : {}),
        ...(name === 'getIntegrationsHealth' ? { squareEnvironment: 'sandbox' } : {}),
      });
    } });
  }
}
