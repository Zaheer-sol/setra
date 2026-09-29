import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { appEnv } from "@setra/config";
import { withGlobal, withSystem, withTenant } from "@setra/database";
import { addMember, createOrganization, createUser } from "@setra/engine";
import { acceptInvitationInput, createOrganizationInput, forgotPasswordInput, loginInput, newId, resetPasswordInput, signupInput } from "@setra/schemas";
import { DUMMY_PASSWORD_HASH, hashIp, hashPassword, randomToken, sha256Hex, verifyPassword } from "@setra/security";
import { clearSessionCookie, createSession } from "../lib/auth";
import { sendEmail } from "../lib/email";
import { ApiError } from "../lib/errors";
import { permissionsFor } from "../lib/principal";
import { parse } from "../lib/route";

/** Authentication, session and workspace-membership endpoints for the console. */
export function authRoutes(app: FastifyInstance) {
  const authLimit = { rateLimit: { max: appEnv().AUTH_RATE_LIMIT_PER_MINUTE, timeWindow: "1 minute" } };

  app.post("/v1/auth/signup", { config: authLimit, schema: { tags: ["auth"], summary: "Create an account" } }, async (request, reply) => {
    const input = parse(signupInput, request.body, "body");
    const user = await createUser({ email: input.email, name: input.name, password: input.password });
    let organizationId: string | null = null;
    if (input.business_name) organizationId = (await createOrganization({ name: input.business_name, ownerUserId: user.id, ownerLabel: user.email })).id;
    await createSession(request, reply, user.id, organizationId);
    return reply.code(201).send({ user: { id: user.id, email: user.email, name: user.name }, organization_id: organizationId });
  });

  app.post("/v1/auth/login", { config: authLimit, schema: { tags: ["auth"], summary: "Sign in" } }, async (request, reply) => {
    const input = parse(loginInput, request.body, "body");
    const user = (await withGlobal((c) => c.query("SELECT id, email, name, password_hash FROM users WHERE lower(email) = $1", [input.email]))).rows[0];
    // Always run the password hash so response time doesn't reveal whether the account exists.
    const ok = await verifyPassword(input.password, user?.password_hash ?? DUMMY_PASSWORD_HASH);
    if (!user || !ok) throw new ApiError(401, "invalid_credentials", "That email and password don't match an account.");
    const membership = (await withGlobal((c) => c.query("SELECT organization_id FROM sessions WHERE user_id = $1 AND organization_id IS NOT NULL ORDER BY created_at DESC LIMIT 1", [user.id]))).rows[0];
    const firstOrg = membership?.organization_id ?? (await firstOrganization(user.id));
    await createSession(request, reply, user.id, firstOrg);
    return { user: { id: user.id, email: user.email, name: user.name }, organization_id: firstOrg };
  });

  app.post("/v1/auth/logout", { schema: { tags: ["auth"], summary: "Sign out" } }, async (request, reply) => {
    if (request.principal?.kind === "user") {
      await withGlobal((c) => c.query("UPDATE sessions SET revoked_at = now() WHERE id = $1", [request.principal!.kind === "user" ? request.principal!.sessionId : ""]));
    }
    clearSessionCookie(reply);
    return reply.code(204).send();
  });

  app.post("/v1/auth/forgot-password", { config: authLimit, schema: { tags: ["auth"], summary: "Request a password reset link" } }, async (request) => {
    const input = parse(forgotPasswordInput, request.body, "body");
    const user = (await withGlobal((c) => c.query("SELECT id, email, name FROM users WHERE lower(email) = $1", [input.email]))).rows[0];
    if (user) {
      const token = randomToken(32);
      await withGlobal((c) =>
        c.query("INSERT INTO password_resets (id, user_id, token_hash, expires_at) VALUES ($1,$2,$3, now() + interval '1 hour')", [newId("passwordReset"), user.id, sha256Hex(token)])
      );
      const link = `${appEnv().publicAppUrl}/reset-password?token=${encodeURIComponent(token)}`;
      await sendEmail(
        { to: user.email, subject: "Reset your Setra password", text: `Hi ${user.name},\n\nReset your password using this link (valid for one hour):\n${link}\n\nIf you didn't ask for this, you can ignore this email.` },
        request.log
      );
    }
    // Same response whether or not the account exists.
    return { ok: true, message: "If an account exists for that email, a reset link is on its way." };
  });

  app.post("/v1/auth/reset-password", { config: authLimit, schema: { tags: ["auth"], summary: "Set a new password with a reset token" } }, async (request, reply) => {
    const input = parse(resetPasswordInput, request.body, "body");
    const reset = (
      await withGlobal((c) => c.query("SELECT * FROM password_resets WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() FOR UPDATE", [sha256Hex(input.token)]))
    ).rows[0];
    if (!reset) throw new ApiError(400, "invalid_reset_token", "This reset link is invalid or has expired. Request a new one.");
    const passwordHash = await hashPassword(input.password);
    await withGlobal(async (c) => {
      await c.query("UPDATE password_resets SET used_at = now() WHERE id = $1", [reset.id]);
      await c.query("UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2", [passwordHash, reset.user_id]);
      await c.query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [reset.user_id]); // sign out everywhere
    });
    await createSession(request, reply, reset.user_id, await firstOrganization(reset.user_id));
    return { ok: true };
  });

  // ── session & workspace ────────────────────────────────────────────────────────────────────

  app.get("/v1/me", { schema: { tags: ["auth"], summary: "The signed-in user, their workspaces and the current mode" } }, async (request) => {
    const p = request.principal;
    if (!p) throw new ApiError(401, "unauthenticated", "Sign in to continue.");
    if (p.kind === "api_key") {
      const org = (await withGlobal((c) => c.query("SELECT id, name FROM organizations WHERE id = $1", [p.organizationId]))).rows[0];
      return { kind: "api_key", organization: org, environment: p.environment, scope: p.scope };
    }
    const orgs = await organizationsForUser(p.userId);
    const current = orgs.find((o) => o.id === p.organizationId) ?? null;
    return {
      kind: "user",
      user: { id: p.userId, email: p.email, name: p.name },
      organization: current,
      organizations: orgs,
      environment: p.environment,
      role: p.role,
      permissions: p.role ? permissionsFor(p.role) : []
    };
  });

  app.post("/v1/session/organization", { schema: { tags: ["auth"], summary: "Switch the console to another workspace" } }, async (request) => {
    const p = request.principal;
    if (p?.kind !== "user") throw new ApiError(401, "unauthenticated", "Sign in to continue.");
    const { organization_id } = parse(z.object({ organization_id: z.string().max(64) }), request.body, "body");
    const orgs = await organizationsForUser(p.userId);
    if (!orgs.some((o) => o.id === organization_id)) throw new ApiError(404, "not_found", "No such workspace.");
    await withGlobal((c) => c.query("UPDATE sessions SET organization_id = $1 WHERE id = $2", [organization_id, p.sessionId]));
    return { ok: true };
  });

  app.post("/v1/session/environment", { schema: { tags: ["auth"], summary: "Switch the console between test and live mode" } }, async (request) => {
    const p = request.principal;
    if (p?.kind !== "user") throw new ApiError(401, "unauthenticated", "Sign in to continue.");
    const { environment } = parse(z.object({ environment: z.enum(["test", "live"]) }), request.body, "body");
    await withGlobal((c) => c.query("UPDATE sessions SET environment = $1 WHERE id = $2", [environment, p.sessionId]));
    return { ok: true, environment };
  });

  app.post("/v1/organizations", { schema: { tags: ["organization"], summary: "Create a workspace (business)" } }, async (request, reply) => {
    const p = request.principal;
    if (p?.kind !== "user") throw new ApiError(401, "unauthenticated", "Sign in to continue.");
    const input = parse(createOrganizationInput, request.body, "body");
    const org = await createOrganization({ name: input.name, ownerUserId: p.userId, ownerLabel: p.email });
    await withGlobal((c) => c.query("UPDATE sessions SET organization_id = $1, environment = 'test' WHERE id = $2", [org.id, p.sessionId]));
    return reply.code(201).send({ id: org.id, name: org.name });
  });

  app.post("/v1/invitations/accept", { config: authLimit, schema: { tags: ["organization"], summary: "Accept a workspace invitation" } }, async (request, reply) => {
    const input = parse(acceptInvitationInput, request.body, "body");
    const invitation = await findInvitation(input.token);
    if (!invitation) throw new ApiError(400, "invalid_invitation", "This invitation is invalid, expired or already used.");
    const p = request.principal;
    let userId: string;
    if (p?.kind === "user") {
      if (p.email.toLowerCase() !== invitation.email.toLowerCase()) throw new ApiError(409, "wrong_account", `This invitation is for ${invitation.email}. Sign in with that account.`);
      userId = p.userId;
    } else {
      const existing = (await withGlobal((c) => c.query("SELECT id FROM users WHERE lower(email) = $1", [invitation.email.toLowerCase()]))).rows[0];
      if (existing) throw new ApiError(409, "sign_in_required", `Sign in as ${invitation.email} to accept this invitation.`);
      if (!input.name || !input.password) throw new ApiError(422, "validation_error", "Enter your name and choose a password.");
      userId = (await createUser({ email: invitation.email, name: input.name, password: input.password })).id;
    }
    await withTenant(invitation.organization_id, (c) => c.query("UPDATE invitations SET accepted_at = now() WHERE id = $1 AND accepted_at IS NULL", [invitation.id]));
    await addMember(invitation.organization_id, userId, invitation.role, { type: "user", id: userId, requestId: request.id, ipHash: hashIp(request.ip, appEnv().sessionSecret) });
    if (p?.kind === "user") await withGlobal((c) => c.query("UPDATE sessions SET organization_id = $1 WHERE id = $2", [invitation.organization_id, p.sessionId]));
    else await createSession(request, reply, userId, invitation.organization_id);
    return { ok: true, organization_id: invitation.organization_id };
  });

  app.get("/v1/invitations/:token", { schema: { tags: ["organization"], summary: "Look up an invitation before accepting" } }, async (request) => {
    const { token } = parse(z.object({ token: z.string().min(20).max(200) }), request.params, "path");
    const invitation = await findInvitation(token);
    if (!invitation) throw new ApiError(404, "invalid_invitation", "This invitation is invalid, expired or already used.");
    const org = (await withGlobal((c) => c.query("SELECT name FROM organizations WHERE id = $1", [invitation.organization_id]))).rows[0];
    const hasAccount = Boolean((await withGlobal((c) => c.query("SELECT 1 FROM users WHERE lower(email) = $1", [invitation.email.toLowerCase()]))).rows[0]);
    return { email: invitation.email, role: invitation.role, organization_name: org?.name, has_account: hasAccount };
  });
}

async function findInvitation(token: string) {
  // Invitations are tenant rows; the token hash is the only lookup key, so use a narrowly scoped system read.
  return (await withSystem((c) => c.query("SELECT * FROM invitations WHERE token_hash = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()", [sha256Hex(token)]))).rows[0];
}

async function firstOrganization(userId: string): Promise<string | null> {
  const orgs = await organizationsForUser(userId);
  return orgs[0]?.id ?? null;
}

/** Workspaces a user belongs to. Membership rows are tenant-scoped, so this reads them through a system query limited to this user. */
export async function organizationsForUser(userId: string): Promise<Array<{ id: string; name: string; role: string; is_demo: boolean; onboarding_completed: boolean }>> {
  const rows = await withSystem((c) =>
    c.query(
      `SELECT o.id, o.name, m.role, o.is_demo, o.onboarding_completed_at IS NOT NULL AS onboarding_completed
         FROM organization_members m JOIN organizations o ON o.id = m.organization_id
        WHERE m.user_id = $1 ORDER BY m.created_at`,
      [userId]
    )
  );
  return rows.rows;
}

