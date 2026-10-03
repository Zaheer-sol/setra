import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { networks } from "@setra/config";
import { counterpartyIntel, isSharedKind, relatedCustomers } from "@setra/engine";
import { ApiError, notFound } from "../../lib/errors";
import { idParam, route } from "../../lib/route";

type Row = Record<string, any>;

const refresh = z.object({ refresh: z.enum(["true", "false"]).default("false").transform((v) => v === "true") });

/** Counterparty intelligence (Nansen): who is behind a wallet that sent or received money, as a hint for a person. */
export function counterpartyRoutes(app: FastifyInstance) {
  route(app, {
    method: "GET",
    url: "/v1/payments/:id/counterparty",
    summary: "Who is behind the wallet that sent this payment? Public labels (Nansen), known customers it has transacted with, and a suggested next step",
    tags: ["payments"],
    permission: "read",
    params: idParam,
    query: refresh,
    rateLimit: { max: 60, timeWindow: "1 minute" },
    handler: async ({ tx, params, query, organizationId, environment }) => {
      const p = (await tx((c) => c.query("SELECT id, chain_id, from_address, customer_id FROM payments WHERE id = $1 AND organization_id = $2 AND environment = $3", [params.id, organizationId, environment]))).rows[0] as Row | undefined;
      if (!p) throw notFound("payment");
      const intel = await counterpartyIntel(organizationId, Number(p.chain_id), p.from_address, { refresh: query.refresh });
      // For a payment nobody could place, also check which known customers this wallet has dealt with.
      const related = !p.customer_id && (intel.status === "ok" || intel.status === "none") ? await relatedCustomers(organizationId, environment, Number(p.chain_id), p.from_address, { refresh: query.refresh }) : null;
      return { payment_id: p.id, from_address: p.from_address, known_customer: !!p.customer_id, ...intel, related_customers: related?.customers ?? [], related_lookback_days: related?.lookbackDays ?? null };
    }
  });

  route(app, {
    method: "GET",
    url: "/v1/outgoing-transfers/:id/counterparty",
    summary: "Who received this outgoing transfer? Public labels (Nansen) and a suggested way to classify it",
    tags: ["accounting"],
    permission: "financials:read",
    params: idParam,
    query: refresh,
    rateLimit: { max: 60, timeWindow: "1 minute" },
    handler: async ({ tx, params, query, organizationId, environment }) => {
      const t = (await tx((c) => c.query("SELECT id, chain_id, to_address FROM outgoing_transfers WHERE id = $1 AND organization_id = $2 AND environment = $3", [params.id, organizationId, environment]))).rows[0] as Row | undefined;
      if (!t) throw notFound("outgoing transfer");
      const intel = await counterpartyIntel(organizationId, Number(t.chain_id), t.to_address, { refresh: query.refresh, direction: "out" });
      return { outgoing_transfer_id: t.id, to_address: t.to_address, ...intel };
    }
  });

  route(app, {
    method: "GET",
    url: "/v1/counterparty/address",
    summary: "Before saving a wallet to a customer or vendor: is it a shared address (an exchange, bridge or app) that many people use?",
    tags: ["customers"],
    permission: "read",
    query: z.object({ address: z.string().trim().toLowerCase(), network: z.enum(["monad", "base", "local"]).default("monad") }),
    rateLimit: { max: 60, timeWindow: "1 minute" },
    handler: async ({ query, organizationId, environment }) => {
      if (!/^0x[0-9a-f]{40}$/.test(query.address)) throw new ApiError(422, "invalid_address", "That isn't a wallet address.");
      const network = networks().resolve(query.network, environment);
      if (!network) throw new ApiError(422, "network_unavailable", "That network isn't enabled for this mode.");
      const intel = await counterpartyIntel(organizationId, network.chainId, query.address);
      const shared = (intel.status === "ok" || intel.status === "none") && isSharedKind(intel.kind);
      return {
        address: query.address,
        ...intel,
        shared,
        warning: shared
          ? `Labelled ${"labels" in intel ? intel.labels.slice(0, 2).map((l) => l.label).join(", ") : "as shared"}. Many people pay from or into it, so saving it to one customer or vendor would tie their money to the wrong record.`
          : null
      };
    }
  });
}
