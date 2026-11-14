import type { FastifyPluginAsync } from 'fastify';
import type { Env } from '../env';

export const healthRoutes: FastifyPluginAsync<{ env: Env }> = async (app, { env }) => {
  app.get('/health', async () => ({
    ok: true,
    service: 'abos-server',
    squareEnvironment: env.SQUARE_ENVIRONMENT,
    time: new Date().toISOString(),
  }));
};
