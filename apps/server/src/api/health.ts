import type { FastifyPluginAsync } from 'fastify';
import type { Env } from '../env';

/** A bounded read-only database check (select 1). Never throws; resolves false on any failure. */
export type DatabaseProbe = () => Promise<boolean>;
export const DATABASE_PROBE_TIMEOUT_MS = 3000;

export const healthRoutes: FastifyPluginAsync<{ env: Env; database?: DatabaseProbe }> = async (app, { env, database }) => {
  app.get('/health', async (request) => {
    // `?refresh=1` also checks the database (Supabase Postgres) with select 1, bounded by a timeout.
    const refresh = (request.query as { refresh?: unknown } | undefined)?.refresh === '1';
    let db: 'ok' | 'unreachable' | 'not_configured' | undefined;
    if (refresh) {
      if (!database) db = 'not_configured';
      else {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), DATABASE_PROBE_TIMEOUT_MS); });
        const ok = await Promise.race([database().catch(() => false), timeout]).finally(() => clearTimeout(timer));
        db = ok ? 'ok' : 'unreachable';
      }
    }
    return {
      ok: true,
      service: 'abos-server',
      squareEnvironment: env.SQUARE_ENVIRONMENT,
      time: new Date().toISOString(),
      ...(db ? { database: db } : {}),
    };
  });
};
