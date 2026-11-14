import type { FastifyPluginAsync } from 'fastify';
import { sha256Hex } from '@abos/contracts';
import { renderBillHtml } from './render';
import type { BillStore } from './types';

export interface BillPluginOptions { store: BillStore; now(): Date }
const NOT_FOUND = 'Bill not found.';
/** Register before any authentication plugin. Route-level silent logging suppresses Fastify URL logs. */
export const billPlugin: FastifyPluginAsync<BillPluginOptions> = async (app, options) => {
  app.get<{ Params: { token: string } }>('/bill/:token', { logLevel: 'silent' }, async (request, reply) => {
    reply.headers({
      'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
    });
    const token = request.params.token;
    // Canonical encoding of exactly 32 bytes. Reject alternate encodings of the same bytes.
    if (!/^[A-Za-z0-9_-]{43}$/.test(token) || Buffer.from(token, 'base64url').toString('base64url') !== token) return reply.code(404).type('text/plain').send(NOT_FOUND);
    try {
      const bill = await options.store.findByTokenHash(await sha256Hex(token));
      if (!bill || !Number.isFinite(Date.parse(bill.expiresAt)) || Date.parse(bill.expiresAt) <= options.now().getTime()) return reply.code(404).type('text/plain').send(NOT_FOUND);
      return reply.type('text/html; charset=utf-8').send(renderBillHtml(bill));
    } catch {
      // Do not attach storage exceptions or the request URL to a logger.
      return reply.code(503).type('text/plain').send('Bill temporarily unavailable.');
    }
  });
};

/** Pass as Fastify({ rewriteUrl: rewriteBillUrl }) before registering this plugin.
 * Runs before URI decoding and request logging, including for malformed escapes and oversized tokens. */
export function rewriteBillUrl(request: { url?: string }): string {
  const url = request.url ?? '/';
  if (url.startsWith('/bill/') && !/^\/bill\/[A-Za-z0-9_-]{43}(?:\?.*)?$/.test(url)) return '/bill/invalid';
  return url;
}
