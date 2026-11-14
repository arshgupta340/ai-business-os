// Seams for the two pieces that are not on this branch yet:
//   B-11 the action executor        apps/server/src/executor/
//   B-13 webhooks and reconciliation apps/server/src/webhooks/, apps/server/src/reconcile/
// Each seam is an interface plus a default that fails closed: with the default, no approved step
// ever runs (it stays QUEUED, so no external write can happen) and every provider webhook is
// answered 503 without reading or storing its body (the provider retries later).
//
// To plug a piece in, pass a factory through `buildApp(env, { executor, webhooks })` or set the
// default in `composeServer` (see the PLUG-IN comments in compose/index.ts).
import type { FastifyPluginAsync } from 'fastify';
import { AppError } from '../errors';
import type { Db } from '../db/index';
import type { Env } from '../env';
import type { PolicyEngine } from '../policy/engine';
import type { InterimDb } from './ports';
import type { Providers } from './providers';

/** Everything an executor or webhook handler may need, already built from the environment. */
export interface SeamDeps {
  env: Env;
  db: Db;
  engine: PolicyEngine;
  providers: Providers;
  /** Writes waiting for migration 0005 (interim-db.ts). */
  interim: InterimDb;
  now(): Date;
  newId(prefix: string): string;
  log: { info(data: Record<string, unknown>, msg: string): void; warn(data: Record<string, unknown>, msg: string): void; error(data: Record<string, unknown>, msg: string): void };
}

/** The action executor: claims approved steps through the database routines and runs them. */
export interface Executor {
  /** Start any polling loop. Called once after the server is listening. */
  start(): void;
  /** Stop polling and wait for running steps to settle. */
  stop(): Promise<void>;
  /** A decision just enqueued steps for this business. The executor may run them now. */
  kick(businessId: string): void;
  /** Resolves when work started by kick() or the poll has settled (tests). */
  idle?(): Promise<void>;
}
export type ExecutorFactory = (deps: SeamDeps) => Executor;

/** Not wired: approved steps stay QUEUED. This can never cause an external write. */
export const notWiredExecutor: ExecutorFactory = (deps) => {
  let warned = false;
  return {
    start() { deps.log.warn({ seam: 'executor' }, 'executor is not wired: approved steps stay QUEUED and nothing external runs'); },
    async stop() { /* nothing to stop */ },
    kick(businessId) {
      if (!warned) { warned = true; deps.log.warn({ seam: 'executor', businessId }, 'approved steps queued, but no executor is wired'); }
    },
  };
};

/** The webhooks plugin owns POST /webhooks/square and POST /webhooks/twilio/status. */
export type WebhooksFactory = (deps: SeamDeps) => FastifyPluginAsync;

/** Not wired: refuse provider webhooks without reading them, so nothing unverified changes state. */
export const notWiredWebhooks: WebhooksFactory = () => async (app) => {
  // Own parser scope: the body is never parsed, whatever its content type. The AppError goes through
  // the app's error handler, so the answer is a full ApiError envelope with the request's correlation ID.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', (_request, _payload, done) => done(null, undefined));
  const refuse = async () => { throw new AppError('INTEGRATION_UNAVAILABLE', 'Webhooks are not wired on this server.'); };
  app.post('/webhooks/square', refuse);
  app.post('/webhooks/twilio/status', refuse);
};
