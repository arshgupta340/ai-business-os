import type { ErrorCode, ExecutionStatus, MessageChannel, MessageChannelSetting, MessageDispatch, MessageDispatchStatus, MessageTemplate } from '@abos/contracts';

export interface SendInput {
  to: MessageDispatch['recipient'];
  body: string;
  idempotencyKey: MessageDispatch['idempotencyKey'];
}

export type SendStatus = Extract<MessageDispatchStatus, 'SENT' | 'FAILED' | 'UNKNOWN'>;
export type SkippedResult = { status: Extract<ExecutionStatus, 'SKIPPED'> };
export type SendResult = { status: SendStatus; providerMessageId?: MessageDispatch['providerMessageId']; errorCode?: ErrorCode } | SkippedResult;

/** Only the executor calls this interface, using the exact owner-approved payload. */
export interface MessageAdapter {
  readonly channel: MessageChannelSetting;
  send(input: SendInput): Promise<SendResult>;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface MessageAdapterConfig {
  channel?: MessageChannelSetting;
  /** Required for network channels. No implicit global fetch or environment reads. */
  fetch?: FetchLike;
  timeoutMs?: number;
  surge?: { apiKey?: string; accountId?: string; baseUrl?: string; linkShortening?: 'disabled' | 'enabled' | 'omit' };
  androidGateway?: {
    kind?: 'textbee' | 'smsgate';
    baseUrl?: string;
    apiKey?: string;
    deviceId?: string;
    username?: string;
    password?: string;
  };
  whatsappSandbox?: { accountSid?: string; authToken?: string; from?: string };
  /** D-12. The sending number is selected by its AgentPhone number ID. */
  agentphone?: { apiKey?: string; numberId?: string; baseUrl?: string };
}

/** The store supplies business, execution and template metadata from the approved execution. */
export type DispatchRecord = Pick<MessageDispatch, 'idempotencyKey' | 'channel' | 'status' | 'providerMessageId' | 'errorCode'>;
export interface DispatchAttempt extends SendInput {
  channel: MessageChannel;
  status: Extract<MessageDispatchStatus, 'QUEUED'>;
}
export type DispatchOutcome = Exclude<SendResult, SkippedResult>;

export interface MessageStore {
  findByKey(key: MessageDispatch['idempotencyKey']): Promise<DispatchRecord | undefined>;
  /** Atomically insert a durable unique key before sending. False means the key already exists.
   * Never replace an existing row, including FAILED. Throwing must also fail closed.
   * Store full recipients only in protected dispatch storage, never in logs.
   */
  recordAttempt(attempt: DispatchAttempt): Promise<boolean>;
  recordOutcome(key: MessageDispatch['idempotencyKey'], outcome: DispatchOutcome): Promise<void>;
}

export interface SendOnceInput {
  dispatchKey: MessageDispatch['idempotencyKey'];
  to: MessageDispatch['recipient'];
  body: string;
}
export type SendOnceResult = Pick<DispatchRecord, 'status' | 'providerMessageId' | 'errorCode'> & { needsReview: boolean }
  | SkippedResult & { needsReview: false };

export interface RenderedMessage {
  body: string;
  templateKey: MessageTemplate;
}
