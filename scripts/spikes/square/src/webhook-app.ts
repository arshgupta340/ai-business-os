// The webhook route as a Fastify app, separate from listen() so tests can
// drive it with app.inject() and no network.
import Fastify, { type FastifyInstance } from "fastify";
import { printSquareError } from "./common.js";
import { computeSignatureHex, headerFormat, verifySignature } from "./verify.js";

export interface WebhookAppOptions {
  notificationUrl: string;
  signatureKey: string;
  /** Called after the 200 reply for each new, verified payment.* event. */
  onPayment: (paymentId: string, eventId: string) => Promise<void>;
}

interface SquareEvent {
  event_id?: string;
  type?: string;
  data?: { type?: string; id?: string; object?: { payment?: { id?: string } } };
}

export function buildWebhookApp(opts: WebhookAppOptions): FastifyInstance {
  const seen = new Set<string>();
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });

  // Keep the body as the exact string Square sent. Any re-serialization breaks the HMAC.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "string" }, (_req, body, done) => done(null, body));

  app.post("/webhooks/square", async (req, reply) => {
    const rawBody = typeof req.body === "string" ? req.body : "";
    const header = req.headers["x-square-hmacsha256-signature"];
    const sig = Array.isArray(header) ? header[0] : header;

    const ok = verifySignature({
      notificationUrl: opts.notificationUrl,
      rawBody,
      signatureKey: opts.signatureKey,
      signatureHeader: sig,
    });
    if (!ok) {
      const hexWouldMatch = !!sig && computeSignatureHex(opts.notificationUrl, rawBody, opts.signatureKey) === sig.trim();
      console.log(
        `BAD SIGNATURE: rejected with 403. header=${headerFormat(sig)} bodyBytes=${Buffer.byteLength(rawBody)}` +
          (hexWouldMatch ? " NOTE: a hex digest would have matched, so the header is hex, not base64." : "") +
          " If every real event fails, check that SQUARE_WEBHOOK_URL is exactly the URL registered in the Developer Console.",
      );
      return reply.code(403).send({ error: "bad signature" });
    }

    let event: SquareEvent;
    try {
      event = JSON.parse(rawBody) as SquareEvent;
    } catch {
      console.log("VERIFIED but body is not JSON. Ignored.");
      return reply.code(200).send({ ok: true });
    }
    const eventId = event.event_id ?? "";
    console.log(`VERIFIED SIGNATURE: event_id=${eventId} type=${event.type ?? "?"} header=${headerFormat(sig)}`);

    if (!eventId) {
      console.log("No event_id. Ignored.");
      return reply.code(200).send({ ok: true });
    }
    if (seen.has(eventId)) {
      console.log(`DUPLICATE EVENT: ${eventId} already processed. 200, no action.`);
      return reply.code(200).send({ ok: true, duplicate: true });
    }
    seen.add(eventId);

    // Answer first, reconcile after (Square wants a reply within 10 seconds).
    reply.code(200).send({ ok: true });

    if (event.type?.startsWith("payment.")) {
      const paymentId = event.data?.object?.payment?.id ?? event.data?.id;
      if (!paymentId) {
        console.log(`payment event ${eventId} carries no payment id. Ignored.`);
        return reply;
      }
      setImmediate(() => {
        void (async () => {
          try {
            await opts.onPayment(paymentId, eventId);
          } catch (err) {
            printSquareError(`reconcile payment ${paymentId}`, err);
          }
        })();
      });
    }
    return reply;
  });

  app.get("/health", async () => ({ ok: true, sandbox: true }));
  return app;
}
