import type { FastifyPluginAsync } from 'fastify';

// The builder on the server. Owner: Saina (decision D-07 in docs/SPEC.md).
//
// Everything under apps/server/src/builder belongs to the builder lane:
// interview, spec generation, text runner, preview and test, publish and
// versions, document extraction, owner voice session.
//
// Register builder routes inside this plugin with their full paths from
// docs/API.md (for example /api/builder/sessions). The server entry file
// registers this plugin once, so nothing outside this directory needs editing.
export const builderPlugin: FastifyPluginAsync = async (app) => {
  app.get('/api/builder/ping', async () => ({ ok: true, lane: 'builder' }));
};
