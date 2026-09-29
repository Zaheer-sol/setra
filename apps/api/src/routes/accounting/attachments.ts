import type { FastifyInstance } from "fastify";
import { addAttachment, getAttachment, listAttachments, removeAttachment } from "@setra/engine";
import { attachmentInput, attachmentListQuery } from "@setra/schemas";
import { idParam, route } from "../../lib/route";

/** Attachments: receipts and documents kept with bills, expenses and journal entries. */
export function attachmentRoutes(app: FastifyInstance) {
  route(app, {
    method: "GET",
    url: "/v1/attachments",
    summary: "Files attached to a bill, expense, journal entry or vendor",
    tags: ["accounting"],
    permission: "financials:read",
    query: attachmentListQuery,
    handler: ({ tx, query, organizationId, environment }) => tx(async (c) => ({ data: await listAttachments(c, organizationId, environment, query.object_type, query.object_id) }))
  });

  route(app, {
    method: "POST",
    url: "/v1/attachments",
    summary: "Attach a receipt or document (PDF, image, CSV or text; up to 10 MB, base64)",
    tags: ["accounting"],
    permission: "financials:write",
    body: attachmentInput,
    bodyLimit: 15 * 1024 * 1024,
    rateLimit: { max: 60, timeWindow: "1 minute" },
    handler: async ({ tx, body, organizationId, environment, actor, reply }) => {
      const a = await tx((c) => addAttachment(c, organizationId, environment, body, actor));
      reply.code(201);
      return a;
    }
  });

  route(app, {
    method: "GET",
    url: "/v1/attachments/:id/download",
    summary: "Download an attached file",
    tags: ["accounting"],
    permission: "financials:read",
    params: idParam,
    handler: ({ tx, params, organizationId, environment, reply }) =>
      tx(async (c) => {
        const a = await getAttachment(c, organizationId, environment, params.id);
        const ascii = a.filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
        reply
          .header("content-type", a.content_type)
          .header("content-disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(a.filename)}`)
          .header("x-content-type-options", "nosniff")
          .header("content-security-policy", "default-src 'none'; sandbox")
          .header("cache-control", "private, no-store");
        return a.data as Buffer;
      })
  });

  route(app, {
    method: "DELETE",
    url: "/v1/attachments/:id",
    summary: "Remove an attached file (kept on record as removed)",
    tags: ["accounting"],
    permission: "financials:write",
    params: idParam,
    handler: ({ tx, params, organizationId, environment, actor }) => tx(async (c) => (await removeAttachment(c, organizationId, environment, params.id, actor), { ok: true }))
  });
}
