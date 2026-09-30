import type { FastifyInstance } from "fastify";
import { booksAttestationStatus, readBooksAttestation, recordBooksAttestation } from "@setra/engine";
import { booksAttestationInput, monthParam } from "@setra/schemas";
import { route } from "../../lib/route";

/** Books on Monad: the fingerprint of a closed month, and attestations the business published from its own wallet. */
export function booksAttestationRoutes(app: FastifyInstance) {
  route(app, {
    method: "GET",
    url: "/v1/accounting/periods/:month/books-attestation",
    summary: "A month's books fingerprint and whether it has been published on Monad",
    tags: ["accounting"],
    permission: "financials:read",
    params: monthParam,
    handler: ({ tx, params, organizationId, environment }) => tx((c) => booksAttestationStatus(c, organizationId, environment, params.month))
  });

  route(app, {
    method: "POST",
    url: "/v1/accounting/periods/:month/books-attestation",
    summary: "Record an attestation published on Monad, after reading it back from the chain",
    tags: ["accounting"],
    permission: "financials:manage",
    sessionOnly: true,
    params: monthParam,
    body: booksAttestationInput,
    handler: async ({ tx, params, body, organizationId, environment, actor }) => {
      // Read the chain first, so no database transaction stays open during the network call.
      const onchain = await readBooksAttestation(environment, body.transaction_hash);
      return tx((c) => recordBooksAttestation(c, organizationId, environment, params.month, onchain, actor));
    }
  });
}
