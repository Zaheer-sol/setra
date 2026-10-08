import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { appEnv } from "@setra/config";
import { withGlobal } from "@setra/database";
import { audit } from "@setra/engine";
import { inviteMemberInput, listQuery, newId, updateMemberInput, updateOrganizationInput } from "@setra/schemas";
import { randomToken, sha256Hex } from "@setra/security";
import { sendEmail } from "../lib/email";
import { ApiError, notFound } from "../lib/errors";
import { cursorClause, page } from "../lib/pagination";
import { idParam, route } from "../lib/route";

export function organizationRoutes(app: FastifyInstance) {
  route(app, {
    method: "GET",
    url: "/v1/organization",
    summary: "Retrieve the current workspace",
    tags: ["organization"],
    permission: "read",
    handler: async ({ organizationId }) => {
      const org = (await withGlobal((c) => c.query("SELECT * FROM organizations WHERE id = $1", [organizationId]))).rows[0];
      return serializeOrg(org);
    }
  });

  route(app, {
    method: "PATCH",
    url: "/v1/organization",
    summary: "Update workspace settings",
    tags: ["organization"],
    permission: "organization:write",
    sessionOnly: true,
    body: updateOrganizationInput,
    handler: async ({ organizationId, body, actor, tx }) => {
      const before = (await withGlobal((c) => c.query("SELECT * FROM organizations WHERE id = $1", [organizationId]))).rows[0];
      const org = (
        await withGlobal((c) =>
          c.query(
            `UPDATE organizations SET name = COALESCE($2, name), support_email = CASE WHEN $3::boolean THEN $4 ELSE support_email END,
               onboarding_completed_at = CASE WHEN $5::boolean IS TRUE AND onboarding_completed_at IS NULL THEN now() ELSE onboarding_completed_at END,
               updated_at = now()
             WHERE id = $1 RETURNING *`,
            [organizationId, body.name ?? null, body.support_email !== undefined, body.support_email ?? null, body.onboarding_completed ?? null]
          )
        )
      ).rows[0];
      await tx((c) => audit(c, actor, { organizationId, action: "organization_updated", objectType: "organization", objectId: organizationId, previous: { name: before.name, support_email: before.support_email }, next: body }));
      return serializeOrg(org);
    }
  });

  route(app, {
    method: "GET",
    url: "/v1/members",
    summary: "List workspace members and pending invitations",
    tags: ["organization"],
    permission: "read",
    sessionOnly: true,
    handler: async ({ tx, organizationId }) => {
      const members = await tx((c) => c.query("SELECT id, user_id, role, created_at FROM organization_members WHERE organization_id = $1 ORDER BY created_at", [organizationId]));
      const userIds = members.rows.map((m) => m.user_id);
      const users = userIds.length ? (await withGlobal((c) => c.query("SELECT id, email, name FROM users WHERE id = ANY($1)", [userIds]))).rows : [];
      const invitations = await tx((c) =>
        c.query("SELECT id, email, role, expires_at, created_at FROM invitations WHERE organization_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at DESC", [organizationId])
      );
      return {
        members: members.rows.map((m) => {
          const u = users.find((x) => x.id === m.user_id);
          return { id: m.id, user_id: m.user_id, name: u?.name, email: u?.email, role: m.role, joined_at: m.created_at };
        }),
        invitations: invitations.rows
      };
    }
  });

  route(app, {
    method: "POST",
    url: "/v1/members/invitations",
    summary: "Invite a teammate",
    tags: ["organization"],
    permission: "members:write",
    sessionOnly: true,
    body: inviteMemberInput,
    handler: async ({ body, tx, organizationId, actor, request, reply }) => {
      const token = randomToken(32);
      const id = newId("invitation");
      await tx(async (c) => {
        const existingMember = await c.query(
          "SELECT 1 FROM organization_members m WHERE m.organization_id = $1 AND m.user_id IN (SELECT id FROM users WHERE lower(email) = $2)",
          [organizationId, body.email]
        );
        if (existingMember.rows[0]) throw new ApiError(409, "already_member", "That person is already a member of this workspace.");
        await c.query("UPDATE invitations SET revoked_at = now() WHERE organization_id = $1 AND lower(email) = $2 AND accepted_at IS NULL AND revoked_at IS NULL", [organizationId, body.email]);
        await c.query("INSERT INTO invitations (id, organization_id, email, role, token_hash, invited_by, expires_at) VALUES ($1,$2,$3,$4,$5,$6, now() + interval '7 days')", [
          id,
          organizationId,
          body.email,
          body.role,
          sha256Hex(token),
          actor.id
        ]);
        await audit(c, actor, { organizationId, action: "member_invited", objectType: "invitation", objectId: id, next: { email: body.email, role: body.role } });
      });
      const org = (await withGlobal((c) => c.query("SELECT name FROM organizations WHERE id = $1", [organizationId]))).rows[0];
      const url = `${appEnv().publicAppUrl}/invite/${encodeURIComponent(token)}`;
      const sent = await sendEmail({ to: body.email, subject: `You've been invited to ${org.name} on Setra`, text: `You've been invited to join ${org.name} on Setra as ${body.role}.\n\nAccept the invitation (valid for 7 days):\n${url}` }, request.log);
      reply.code(201);
      // The link is returned once so the inviter can share it directly when email isn't configured.
      return { id, email: body.email, role: body.role, invitation_url: url, email_sent: sent.delivered };
    }
  });

  route(app, {
    method: "DELETE",
    url: "/v1/members/invitations/:id",
    summary: "Revoke a pending invitation",
    tags: ["organization"],
    permission: "members:write",
    sessionOnly: true,
    params: idParam,
    handler: async ({ params, tx, organizationId, actor }) => {
      await tx(async (c) => {
        const r = await c.query("UPDATE invitations SET revoked_at = now() WHERE id = $1 AND organization_id = $2 AND accepted_at IS NULL RETURNING id", [params.id, organizationId]);
        if (!r.rows[0]) throw notFound("invitation");
        await audit(c, actor, { organizationId, action: "invitation_revoked", objectType: "invitation", objectId: params.id });
      });
      return { ok: true };
    }
  });

  route(app, {
    method: "PATCH",
    url: "/v1/members/:id",
    summary: "Change a member's role",
    tags: ["organization"],
    permission: "members:write",
    sessionOnly: true,
    params: idParam,
    body: updateMemberInput,
    handler: async ({ params, body, tx, organizationId, actor }) => {
      return tx(async (c) => {
        const m = (await c.query("SELECT * FROM organization_members WHERE id = $1 AND organization_id = $2 FOR UPDATE", [params.id, organizationId])).rows[0];
        if (!m) throw notFound("member");
        if (m.role === "owner") throw new ApiError(409, "owner_role_fixed", "The owner's role can't be changed.");
        await c.query("UPDATE organization_members SET role = $1, updated_at = now() WHERE id = $2", [body.role, m.id]);
        await audit(c, actor, { organizationId, action: "member_role_changed", objectType: "user", objectId: m.user_id, previous: { role: m.role }, next: { role: body.role } });
        return { id: m.id, role: body.role };
      });
    }
  });

  route(app, {
    method: "DELETE",
    url: "/v1/members/:id",
    summary: "Remove a member",
    tags: ["organization"],
    permission: "members:write",
    sessionOnly: true,
    params: idParam,
    handler: async ({ params, tx, organizationId, actor }) => {
      return tx(async (c) => {
        const m = (await c.query("SELECT * FROM organization_members WHERE id = $1 AND organization_id = $2 FOR UPDATE", [params.id, organizationId])).rows[0];
        if (!m) throw notFound("member");
        if (m.role === "owner") throw new ApiError(409, "owner_cannot_be_removed", "The workspace owner can't be removed.");
        await c.query("DELETE FROM organization_members WHERE id = $1", [m.id]);
        await audit(c, actor, { organizationId, action: "member_removed", objectType: "user", objectId: m.user_id, previous: { role: m.role } });
        return { ok: true };
      });
    }
  });

  route(app, {
    method: "GET",
    url: "/v1/audit-logs",
    summary: "List audit log entries",
    tags: ["organization"],
    permission: "read",
    query: listQuery.extend({ object_id: z.string().max(64).optional(), action: z.string().max(64).optional() }),
    handler: async ({ query, tx, organizationId }) => {
      const params: unknown[] = [organizationId];
      let where = "organization_id = $1";
      if (query.object_id) {
        params.push(query.object_id);
        where += ` AND object_id = $${params.length}`;
      }
      if (query.action) {
        params.push(query.action);
        where += ` AND action = $${params.length}`;
      }
      where += cursorClause(params, query.starting_after);
      params.push(query.limit + 1);
      const rows = await tx((c) => c.query(`SELECT * FROM audit_logs WHERE ${where} ORDER BY id DESC LIMIT $${params.length}`, params));
      return page(rows.rows, query.limit, (r) => ({
        id: r.id,
        action: r.action,
        object_type: r.object_type,
        object_id: r.object_id,
        environment: r.environment,
        actor: { type: r.actor_type, id: r.actor_id, label: r.actor_label },
        previous_state: r.previous_state,
        new_state: r.new_state,
        request_id: r.request_id,
        created_at: r.created_at
      }));
    }
  });
}

function serializeOrg(org: Record<string, any>) {
  return {
    id: org.id,
    object: "organization",
    name: org.name,
    slug: org.slug,
    support_email: org.support_email ?? null,
    is_demo: org.is_demo,
    onboarding_completed: org.onboarding_completed_at !== null,
    created_at: org.created_at
  };
}
