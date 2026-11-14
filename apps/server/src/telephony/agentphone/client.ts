// AgentPhone REST reads the server makes (D-12). Endpoints and fields from the vendor's documentation and
// OpenAPI file, not tested against a live account (docs/notes-agentphone.md):
//   GET /v1/numbers/{number_id}           -> { id, phoneNumber, outboundSms: enabled | activating | registration_required }
//   GET /v1/numbers/{number_id}/messages  -> { data: [{ id, status, ... }], hasMore, nextCursor }
// Reads only. Sends go through the message adapter (adapters/message, channel 'agentphone').
// The HTTP port is injected; tests never touch the network. Errors never carry a body, key or number.
export const AGENTPHONE_API_BASE = 'https://api.agentphone.ai';
export const AGENTPHONE_READ_TIMEOUT_MS = 5000;

export type HttpPort = (url: string, init: { method: 'GET'; headers: Record<string, string>; signal: AbortSignal }) => Promise<{ status: number; json(): Promise<unknown> }>;

export type NumberStatus = { outboundSms: 'enabled' | 'activating' | 'registration_required' | 'unknown' };
export type MessageStatus = { id: string; status: string };

export interface AgentPhoneClient {
  getNumber(): Promise<NumberStatus>;
  /** One page of the number's message history, newest first per the docs' cursor paging. */
  listMessages(input: { limit: number; cursor?: string | undefined }): Promise<{ messages: MessageStatus[]; nextCursor: string | undefined }>;
}

export class AgentPhoneReadError extends Error {
  constructor(readonly status: number | 'timeout' | 'network' | 'shape') {
    super(`AgentPhone read failed: ${status}`);
    this.name = 'AgentPhoneReadError';
  }
}

const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function createAgentPhoneClient(config: { apiKey: string; numberId: string; http: HttpPort; baseUrl?: string; timeoutMs?: number }): AgentPhoneClient {
  const base = (config.baseUrl ?? AGENTPHONE_API_BASE).replace(/\/+$/, '');
  const headers = { Authorization: `Bearer ${config.apiKey}`, Accept: 'application/json' };
  async function get(path: string): Promise<unknown> {
    let res: { status: number; json(): Promise<unknown> };
    try {
      res = await config.http(`${base}${path}`, { method: 'GET', headers, signal: AbortSignal.timeout(config.timeoutMs ?? AGENTPHONE_READ_TIMEOUT_MS) });
    } catch (error) {
      throw new AgentPhoneReadError(error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network');
    }
    if (res.status < 200 || res.status >= 300) throw new AgentPhoneReadError(res.status);
    try { return await res.json(); } catch { throw new AgentPhoneReadError('shape'); }
  }
  const numberPath = `/v1/numbers/${encodeURIComponent(config.numberId)}`;
  return {
    async getNumber() {
      const json = await get(numberPath);
      if (!obj(json) || typeof json.id !== 'string') throw new AgentPhoneReadError('shape');
      const s = json.outboundSms;
      return { outboundSms: s === 'enabled' || s === 'activating' || s === 'registration_required' ? s : 'unknown' };
    },
    // UNTESTED GUESS: the list envelope (`data`, `hasMore`, `nextCursor`) and the `limit` and `cursor` query
    // names are taken from the OpenAPI file, not from a real answer. If they differ, every delivery-status
    // poll fails with AgentPhoneReadError('shape') and dispatches stay SENT; nothing is written wrongly.
    async listMessages({ limit, cursor }) {
      const q = new URLSearchParams({ limit: String(limit), ...(cursor ? { cursor } : {}) });
      const json = await get(`${numberPath}/messages?${q.toString()}`);
      if (!obj(json) || !Array.isArray(json.data)) throw new AgentPhoneReadError('shape');
      const messages = json.data.flatMap((m): MessageStatus[] => (obj(m) && typeof m.id === 'string' && typeof m.status === 'string' ? [{ id: m.id, status: m.status }] : []));
      const next = json.hasMore === true && typeof json.nextCursor === 'string' && json.nextCursor ? json.nextCursor : undefined;
      return { messages, nextCursor: next };
    },
  };
}
