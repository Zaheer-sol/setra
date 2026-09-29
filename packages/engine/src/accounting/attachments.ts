import { createHash } from "node:crypto";
import { type Client } from "@setra/database";
import { newId, type Environment } from "@setra/schemas";
import { audit, EngineError, type Actor } from "../context";

type Row = Record<string, any>;

export const ATTACHMENT_TYPES = ["application/pdf", "image/png", "image/jpeg", "image/webp", "text/csv", "text/plain"] as const;

export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

const OBJECT_TABLE: Record<string, string> = { bill: "bills", expense: "expenses", journal_entry: "journal_entries", vendor: "vendors" };

/** The file's bytes must be what its type says; a renamed executable is refused. */
function sniff(data: Buffer, type: string): boolean {
  const starts = (...bytes: number[]) => bytes.every((b, i) => data[i] === b);
  switch (type) {
    case "application/pdf":
      return data.subarray(0, 5).toString("latin1") === "%PDF-";
    case "image/png":
      return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case "image/jpeg":
      return starts(0xff, 0xd8, 0xff);
    case "image/webp":
      return data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP";
    default: {
      if (data.includes(0)) return false;
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(data);
        return true;
      } catch {
        return false;
      }
    }
  }
}

const cleanName = (name: string) =>
  name
    .split(/[\\/]/)
    .pop()!
    .replace(/[\u0000-\u001f\u007f"<>|*?:]/g, "")
    .trim()
    .slice(0, 200) || "file";

export async function addAttachment(
  client: Client,
  organizationId: string,
  environment: Environment,
  input: { object_type: string; object_id: string; filename: string; content_type: string; data_base64: string },
  actor: Actor
): Promise<Row> {
  const table = OBJECT_TABLE[input.object_type];
  if (!table) throw new EngineError("invalid_object", "Attach files to a bill, expense, journal entry or vendor.", 422);
  const owner = (await client.query(`SELECT id FROM ${table} WHERE id = $1 AND organization_id = $2 AND environment = $3`, [input.object_id, organizationId, environment])).rows[0];
  if (!owner) throw new EngineError("not_found", `No such ${input.object_type.replace("_", " ")}.`, 404);
  if (!(ATTACHMENT_TYPES as readonly string[]).includes(input.content_type)) throw new EngineError("unsupported_file", "Attach a PDF, PNG, JPEG, WebP, CSV or text file.", 422);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(input.data_base64)) throw new EngineError("invalid_file", "The file couldn't be read.", 422);
  const data = Buffer.from(input.data_base64, "base64");
  if (data.length === 0) throw new EngineError("invalid_file", "The file is empty.", 422);
  if (data.length > ATTACHMENT_MAX_BYTES) throw new EngineError("file_too_large", "Files can be up to 10 MB.", 422);
  if (!sniff(data, input.content_type)) throw new EngineError("file_type_mismatch", "The file's contents don't match its type.", 422);
  const count = (await client.query<{ n: number }>("SELECT count(*)::int AS n FROM attachments WHERE organization_id = $1 AND object_type = $2 AND object_id = $3 AND removed_at IS NULL", [organizationId, input.object_type, input.object_id])).rows[0]!.n;
  if (count >= 20) throw new EngineError("too_many_files", "A record can have up to 20 files.", 422);
  const id = newId("attachment");
  const sha256 = createHash("sha256").update(data).digest("hex");
  const filename = cleanName(input.filename);
  await client.query(
    `INSERT INTO attachments (id, organization_id, environment, object_type, object_id, filename, content_type, size_bytes, sha256, data, uploaded_by_label) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [id, organizationId, environment, input.object_type, input.object_id, filename, input.content_type, data.length, sha256, data, actor.label ?? null]
  );
  await audit(client, actor, { organizationId, environment, action: "attachment_added", objectType: input.object_type, objectId: input.object_id, next: { attachment_id: id, filename, size: data.length, sha256 } });
  return { id, filename, content_type: input.content_type, size_bytes: data.length, sha256 };
}

export async function listAttachments(client: Client, organizationId: string, environment: Environment, objectType: string, objectId: string): Promise<Row[]> {
  return (
    await client.query(
      "SELECT id, filename, content_type, size_bytes, sha256, uploaded_by_label, created_at FROM attachments WHERE organization_id = $1 AND environment = $2 AND object_type = $3 AND object_id = $4 AND removed_at IS NULL ORDER BY created_at",
      [organizationId, environment, objectType, objectId]
    )
  ).rows as Row[];
}

export async function getAttachment(client: Client, organizationId: string, environment: Environment, id: string): Promise<Row> {
  const a = (await client.query("SELECT * FROM attachments WHERE id = $1 AND organization_id = $2 AND environment = $3 AND removed_at IS NULL", [id, organizationId, environment])).rows[0] as Row | undefined;
  if (!a) throw new EngineError("not_found", "No such file.", 404);
  return a;
}

export async function removeAttachment(client: Client, organizationId: string, environment: Environment, id: string, actor: Actor): Promise<void> {
  const a = await getAttachment(client, organizationId, environment, id);
  await client.query("UPDATE attachments SET removed_at = now(), removed_by_label = $2 WHERE id = $1", [id, actor.label ?? null]);
  await audit(client, actor, { organizationId, environment, action: "attachment_removed", objectType: a.object_type, objectId: a.object_id, previous: { attachment_id: id, filename: a.filename } });
}
