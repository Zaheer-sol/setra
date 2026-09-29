import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { counterpartyIntel } from "@setra/engine";
import { notFound } from "../../lib/errors";
import { idParam, route } from "../../lib/route";

type Row = Record<string, any>;

/** Counterparty intelligence: public labels for the sender of an unidentified payment. */
export function counterpartyRoutes(app: FastifyInstance) {
  route(app, {
    method: "GET",
    url: "/v1/payments/:id/counterparty",
    summary: "Who is behind the wallet that sent this payment? Public labels (Nansen) with a suggested next step",
    tags: ["payments"],
    permission: "read",
    params: idParam,
    query: z.object({ refresh: z.enum(["true", "false"]).default("false").transform((v) => v === "true") }),
    rateLimit: { max: 60, timeWindow: "1 minute" },
    handler: async ({ tx, params, query, organizationId, environment }) => {
      const p = (await tx((c) => c.query("SELECT id, chain_id, from_address, customer_id FROM payments WHERE id = $1 AND organization_id = $2 AND environment = $3", [params.id, organizationId, environment]))).rows[0] as Row | undefined;
      if (!p) throw notFound("payment");
      const intel = await counterpartyIntel(organizationId, Number(p.chain_id), p.from_address, { refresh: query.refresh });
      return { payment_id: p.id, from_address: p.from_address, known_customer: !!p.customer_id, ...intel };
    }
  });
}
