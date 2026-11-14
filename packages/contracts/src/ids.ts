import { z } from 'zod';

// SPEC 2.1: every ID is text with a type prefix.
export const ID_PREFIXES = {
  user: 'usr_',
  business: 'biz_',
  agent: 'agt_',
  agentVersion: 'agv_',
  order: 'ord_',
  quote: 'qte_',
  booking: 'bkg_',
  service: 'svc_',
  approval: 'apv_',
  execution: 'exe_',
  call: 'call_',
  event: 'evt_',
  message: 'msg_',
  fact: 'fact_',
  factConflict: 'cfl_',
  file: 'file_',
  job: 'job_',
  builderSession: 'bld_',
  builderMessage: 'bmsg_',
  testSession: 'tst_',
  integration: 'int_',
  catalogItem: 'cat_',
  webhookEvent: 'whk_',
  syncJob: 'syn_',
} as const;

export type IdKind = keyof typeof ID_PREFIXES;
export type IdPrefix = (typeof ID_PREFIXES)[IdKind];

/** SPEC 2.1: the mock toolset returns approvals with this prefix. It still matches `apv_`. */
export const MOCK_APPROVAL_PREFIX = 'apv_mock_';

function prefixedId(prefix: string) {
  return z.string().regex(new RegExp(`^${prefix}[A-Za-z0-9_]+$`), { error: `must be an ID starting with ${prefix}` });
}

export const UserIdSchema = prefixedId(ID_PREFIXES.user);
export const BusinessIdSchema = prefixedId(ID_PREFIXES.business);
export const AgentIdSchema = prefixedId(ID_PREFIXES.agent);
export const AgentVersionIdSchema = prefixedId(ID_PREFIXES.agentVersion);
export const OrderIdSchema = prefixedId(ID_PREFIXES.order);
export const QuoteIdSchema = prefixedId(ID_PREFIXES.quote);
export const BookingIdSchema = prefixedId(ID_PREFIXES.booking);
export const ServiceIdSchema = prefixedId(ID_PREFIXES.service);
export const ApprovalIdSchema = prefixedId(ID_PREFIXES.approval);
export const ExecutionIdSchema = prefixedId(ID_PREFIXES.execution);
export const CallIdSchema = prefixedId(ID_PREFIXES.call);
export const EventIdSchema = prefixedId(ID_PREFIXES.event);
export const MessageDispatchIdSchema = prefixedId(ID_PREFIXES.message);
export const FactIdSchema = prefixedId(ID_PREFIXES.fact);
export const FactConflictIdSchema = prefixedId(ID_PREFIXES.factConflict);
export const FileIdSchema = prefixedId(ID_PREFIXES.file);
export const JobIdSchema = prefixedId(ID_PREFIXES.job);
export const BuilderSessionIdSchema = prefixedId(ID_PREFIXES.builderSession);
export const BuilderMessageIdSchema = prefixedId(ID_PREFIXES.builderMessage);
export const TestSessionIdSchema = prefixedId(ID_PREFIXES.testSession);
export const IntegrationIdSchema = prefixedId(ID_PREFIXES.integration);
export const CatalogItemRowIdSchema = prefixedId(ID_PREFIXES.catalogItem);
export const WebhookEventIdSchema = prefixedId(ID_PREFIXES.webhookEvent);
export const SyncJobIdSchema = prefixedId(ID_PREFIXES.syncJob);

/** Same shape as the database `gen_id(prefix)`: the prefix plus 32 lowercase hex characters. Works in Node and the browser. */
export function newId(prefix: IdPrefix): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return prefix + hex;
}
