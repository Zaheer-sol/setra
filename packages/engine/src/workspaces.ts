import { isUniqueViolation, withGlobal, withTenant } from "@setra/database";
import { newId, type Role } from "@setra/schemas";
import { hashPassword } from "@setra/security";
import { audit, EngineError, type Actor } from "./context";

/** Create a user account. Emails are unique case-insensitively. */
export async function createUser(input: { email: string; name: string; password: string }): Promise<{ id: string; email: string; name: string }> {
  const id = newId("user");
  const passwordHash = await hashPassword(input.password);
  try {
    await withGlobal((client) => client.query("INSERT INTO users (id, email, name, password_hash) VALUES ($1,$2,$3,$4)", [id, input.email.toLowerCase(), input.name, passwordHash]));
  } catch (error) {
    if (isUniqueViolation(error)) throw new EngineError("email_taken", "An account with this email already exists. Sign in instead.", 409);
    throw error;
  }
  return { id, email: input.email.toLowerCase(), name: input.name };
}

function slugify(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "workspace";
  return `${base}-${newId("organization").slice(-6).toLowerCase()}`;
}

/** Create an organization with its first member as owner. */
export async function createOrganization(input: { name: string; ownerUserId: string; ownerLabel?: string }): Promise<{ id: string; name: string; slug: string }> {
  const id = newId("organization");
  const slug = slugify(input.name);
  await withGlobal((client) => client.query("INSERT INTO organizations (id, name, slug) VALUES ($1,$2,$3)", [id, input.name, slug]));
  await withTenant(id, async (client) => {
    await client.query("INSERT INTO organization_members (id, organization_id, user_id, role) VALUES ($1,$2,$3,'owner')", [newId("member"), id, input.ownerUserId]);
    const actor: Actor = { type: "user", id: input.ownerUserId, label: input.ownerLabel ?? null };
    await audit(client, actor, { organizationId: id, action: "organization_created", objectType: "organization", objectId: id, next: { name: input.name } });
  });
  return { id, name: input.name, slug };
}

export async function addMember(organizationId: string, userId: string, role: Exclude<Role, "owner">, actor: Actor): Promise<void> {
  await withTenant(organizationId, async (client) => {
    await client.query(
      "INSERT INTO organization_members (id, organization_id, user_id, role) VALUES ($1,$2,$3,$4) ON CONFLICT (organization_id, user_id) DO NOTHING",
      [newId("member"), organizationId, userId, role]
    );
    await audit(client, actor, { organizationId, action: "member_added", objectType: "user", objectId: userId, next: { role } });
  });
}
