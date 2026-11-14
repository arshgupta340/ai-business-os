import { randomUUID } from 'node:crypto';
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

export async function buildApp(env: Env, options: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });

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
      const body: ErrorEnvelope = {
        code: error.code,
        message: error.message,
        correlationId: request.correlationId,
        retryable: error.retryable,
        ...(error.details === undefined ? {} : { details: error.details }),
      };
      return reply.status(error.status).send(body);
    }
    const raw = (error as { statusCode?: unknown }).statusCode;
    const status = typeof raw === 'number' ? raw : 500;
    if (status >= 500) request.log.error({ err: error }, 'unhandled error');
    const body: ErrorEnvelope = {
      code: status === 400 ? 'VALIDATION_FAILED' : status === 404 ? 'NOT_FOUND' : 'INTERNAL',
      // Never leak internals: only client errors keep their own message.
      message: status < 500 && error instanceof Error ? error.message : 'Something went wrong.',
      correlationId: request.correlationId,
      retryable: status >= 500,
    };
    return reply.status(status).send(body);
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

  await app.register(healthRoutes, { env });
  await app.register(builderPlugin);

  return app;
}
