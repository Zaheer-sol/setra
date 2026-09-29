import type { FastifyInstance } from "fastify";
import { createRecurringBill, generateDueRecurringBills, serializeRecurring, setRecurringBillStatus } from "@setra/engine";
import { recurringBillInput, recurringStatusInput } from "@setra/schemas";
import { forbidden } from "../../lib/errors";
import { can } from "../../lib/principal";
import { idParam, route } from "../../lib/route";

type Row = Record<string, any>;

/** Recurring bills: templates that create a bill on schedule. */
export function recurringBillRoutes(app: FastifyInstance) {
  route(app, {
    method: "GET",
    url: "/v1/recurring-bills",
    summary: "Recurring bill schedules",
    tags: ["bills"],
    permission: "financials:read",
    handler: ({ tx, organizationId, environment }) =>
      tx(async (c) => ({
        data: ((await c.query("SELECT r.*, v.name AS vendor_name FROM recurring_bills r JOIN vendors v ON v.id = r.vendor_id WHERE r.organization_id = $1 AND r.environment = $2 ORDER BY r.status, r.next_date", [organizationId, environment])).rows as Row[]).map(serializeRecurring)
      }))
  });

  route(app, {
    method: "POST",
    url: "/v1/recurring-bills",
    summary: "Create a recurring bill schedule (bills are created automatically when due)",
    tags: ["bills"],
    permission: "financials:write",
    idempotent: true,
    body: recurringBillInput,
    handler: async ({ tx, body, principal, organizationId, environment, actor, reply }) => {
      if (body.auto_approve && !can(principal, "financials:approve")) throw forbidden("Automatically approved bills need approval rights. Leave auto-approve off.");
      const r = await tx(async (c) => {
        const created = await createRecurringBill(c, organizationId, environment, body, actor);
        await generateDueRecurringBills(c, organizationId, environment);
        return created;
      });
      reply.code(201);
      return r;
    }
  });

  route(app, {
    method: "POST",
    url: "/v1/recurring-bills/:id/status",
    summary: "Pause, resume or end a recurring bill schedule",
    tags: ["bills"],
    permission: "financials:write",
    params: idParam,
    body: recurringStatusInput,
    handler: ({ tx, params, body, organizationId, environment, actor }) => tx((c) => setRecurringBillStatus(c, organizationId, environment, params.id, body.status, actor))
  });
}
