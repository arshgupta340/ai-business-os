import { randomUUID } from 'node:crypto';
import { ERROR_CODE_INFO, type ErrorCode } from '@abos/contracts';
import cors from '@fastify/cors';
import { createDb, createPool, unavailableDb, type Db } from './db/index';
import { createVerifier, createAuthGuard, type TokenVerifier } from './auth/verify';
import { apiRoutes } from './api/routes';
import { unavailableEngine, type EnginePorts, type CatalogPort } from './api/ports';
import Fastify, { type FastifyInstance } from 'fastify';
import { healthRoutes } from './api/health';
import { builderPlugin } from './builder/index';
import type { Env } from './env';
import { AppError, type ErrorEnvelope } from './errors';

declare module 'fastify' {
  interface FastifyRequest {
    correlationId: string;
  }
}

const CORRELATION_HEADER = 'x-correlation-id';
const SAFE_ID = /^[A-Za-z0-9._-]{8,128}$/;

export async function buildApp(env: Env, options: { logger?: boolean; db?: Db; verifier?: TokenVerifier; ports?: EnginePorts; catalog?: CatalogPort; webOrigin?: string } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });

  const pool = !options.db && env.DATABASE_URL ? createPool(env) : undefined;
  const db = options.db ?? (pool ? createDb(pool) : unavailableDb);
  if (pool) app.addHook('onClose', async () => { await pool.end(); });

  // Every request gets a correlation ID, and every response carries it back
  // (docs/SPEC.md section 2.9). A caller-supplied ID is used only if it is
  // well formed, so nothing untrusted is echoed into a header.
  app.decorateRequest('correlationId', '');
  app.addHook('onRequest', async (request, reply) => {
    const incoming = request.headers[CORRELATION_HEADER];
    request.correlationId = typeof incoming === 'string' && SAFE_ID.test(incoming) ? incoming : randomUUID();
    reply.header('X-Correlation-Id', request.correlationId);
  });

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof AppError) {
      if (error.status >= 500) request.log.error({ code: error.code, correlationId: request.correlationId }, 'Request failed');
      const body: ErrorEnvelope = {
        code: error.code,
        message: error.message,
        correlationId: request.correlationId,
        retryable: error.retryable,
        ...(error.details === undefined ? {} : { details: error.details }),
      };
      return reply.status(error.status).send(body);
    }
    const raw = error && typeof error === 'object' && 'statusCode' in error ? error.statusCode : undefined;
    const status = typeof raw === 'number' ? raw : 500;
    if (status >= 500) request.log.error({ correlationId: request.correlationId }, 'unhandled error');
    const code: ErrorCode = status === 404 ? 'NOT_FOUND' : status === 429 ? 'RATE_LIMITED' : status >= 400 && status < 500 ? 'VALIDATION_FAILED' : 'INTERNAL';
    const body: ErrorEnvelope = {
      code,
      // Parser messages can contain request values. Keep them out of the envelope.
      message: code === 'VALIDATION_FAILED' ? 'Request validation failed.' : code === 'NOT_FOUND' ? 'Resource was not found.' : code === 'RATE_LIMITED' ? 'Too many requests.' : 'Something went wrong.',
      correlationId: request.correlationId,
      retryable: ERROR_CODE_INFO[code].retryable,
    };
    return reply.status(ERROR_CODE_INFO[code].httpStatus).send(body);
  });

  app.setNotFoundHandler((request, reply) => {
    const body: ErrorEnvelope = {
      code: 'NOT_FOUND',
      message: `No route for ${request.method} ${request.url.split('?')[0]}`,
      correlationId: request.correlationId,
      retryable: false,
    };
    return reply.status(404).send(body);
  });

  await app.register(cors, {
    origin: options.webOrigin ?? env.WEB_ORIGIN ?? 'http://localhost:3000',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Correlation-Id', 'Idempotency-Key'],
    exposedHeaders: ['X-Correlation-Id'],
  });
  app.decorateRequest('ownerUserId', '');
  app.decorateRequest('businessId', undefined);
  app.addHook('preHandler', createAuthGuard(db, options.verifier ?? createVerifier(env)));
  await app.register(apiRoutes, { db, ports: options.ports ?? unavailableEngine, env, catalog: options.catalog });
  await app.register(healthRoutes, { env });
  await app.register(builderPlugin);

  return app;
}
