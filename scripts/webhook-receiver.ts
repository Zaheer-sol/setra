import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { verifySetraWebhook } from "../packages/sdk/src";

/**
 * A tiny local webhook receiver for demos and development. Verifies every Setra signature and
 * prints the event. The demo seed points its webhook endpoint here (http://localhost:4040/webhooks).
 */
const port = Number(process.env.RECEIVER_PORT ?? 4040);
const secretFile = ".setra-demo-webhook-secret";
const secret = process.env.SETRA_WEBHOOK_SECRET ?? (existsSync(secretFile) ? readFileSync(secretFile, "utf8").trim() : "");
if (!secret) console.warn("No secret: set SETRA_WEBHOOK_SECRET or run `npm run db:seed` first. Signatures will fail.");

createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const ok = verifySetraWebhook(secret, body, req.headers["x-setra-timestamp"] as string, req.headers["x-setra-signature"] as string);
    if (!ok) {
      console.log(`✗ rejected ${req.headers["x-setra-event-type"]}, invalid signature`);
      res.writeHead(400).end("invalid signature");
      return;
    }
    const event = JSON.parse(body);
    const d = event.data ?? {};
    console.log(`✓ ${event.type}  ${d.invoice?.number ?? ""} ${d.customer?.name ?? ""} ${d.payment?.amount ?? ""} ${d.payment?.asset ?? ""}  [${req.headers["x-setra-delivery-id"]}]`);
    res.writeHead(200, { "content-type": "application/json" }).end('{"received":true}');
  });
}).listen(port, () => console.log(`Setra webhook receiver listening on http://localhost:${port}/webhooks`));
