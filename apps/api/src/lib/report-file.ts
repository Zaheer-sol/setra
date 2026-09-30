import type { FastifyReply } from "fastify";
import type { Client } from "@setra/database";
import type { Actor } from "@setra/engine";
import type { Environment } from "@setra/schemas";
import { toCsv } from "./csv";

type Cells = Array<Array<string | number | null | undefined>>;

/** Whose file this is: every export is named for, and headed with, the business it belongs to. */
export interface ExportOwner {
  name: string;
  slug: string;
  environment: Environment;
  basis: "accrual" | "cash" | null;
  generatedBy: string | null;
}

/** The workspace's name as a filename part: plain ASCII, lowercase, hyphenated. */
export const fileSlug = (name: string) =>
  name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "") || "workspace";

export async function exportOwner(c: Client, organizationId: string, environment: Environment, actor?: Actor): Promise<ExportOwner> {
  const row = (
    await c.query<{ name: string; method: "accrual" | "cash" | null }>(
      "SELECT o.name, s.method FROM organizations o LEFT JOIN accounting_settings s ON s.organization_id = o.id AND s.environment = $2 WHERE o.id = $1",
      [organizationId, environment]
    )
  ).rows[0];
  const name = row?.name ?? "Workspace";
  return { name, slug: fileSlug(name), environment, basis: row?.method ?? null, generatedBy: actor?.label ?? null };
}

/** acme-infrastructure-profit-and-loss-2026-09-01-to-2026-09-30[-test].csv */
export function exportFilename(owner: ExportOwner, what: string, period?: string | null): string {
  return `${owner.slug}-${what}${period ? `-${period}` : ""}${owner.environment === "test" ? "-test" : ""}.csv`;
}

function attach(reply: FastifyReply, filename: string) {
  reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", `attachment; filename="${filename}"`);
}

/**
 * A data file (a list meant for a spreadsheet or another system): the columns stay exactly as they
 * are, so nothing breaks when it's imported, and the filename says whose data it is.
 */
export function sendDataCsv(reply: FastifyReply, owner: ExportOwner, what: string, headers: string[], rows: Cells, period?: string | null) {
  attach(reply, exportFilename(owner, what, period));
  return toCsv(headers, rows);
}

export type ReportPeriod = { from: string; to: string } | { asOf: string } | { label: string };

/**
 * A report as a business would hand it to its accountant: headed with the business's name, the
 * report, its period, basis, currency and mode, and when and by whom it was generated. Starts with a
 * UTF-8 byte order mark so Excel shows names with accents and symbols correctly.
 */
export function sendReportCsv(
  reply: FastifyReply,
  owner: ExportOwner,
  report: { file: string; title: string; period: ReportPeriod; headers: string[]; rows: Cells; details?: Array<[string, string]> }
) {
  const p = report.period;
  const periodLine: [string, string] = "from" in p ? ["Period", `${p.from} to ${p.to}`] : "asOf" in p ? ["As of", p.asOf] : ["Period", p.label];
  const periodFile = "from" in p ? `${p.from}-to-${p.to}` : "asOf" in p ? p.asOf : null;
  const generated = new Date().toISOString().slice(0, 16).replace("T", " ");
  const preamble: Cells = [
    [owner.name],
    [report.title],
    periodLine,
    ...(owner.basis ? [["Basis", owner.basis === "accrual" ? "Accrual" : "Cash"]] : []),
    ["Currency", "USD (stablecoins valued at their peg)"],
    ["Mode", owner.environment === "test" ? "Test mode: Monad testnet and simulated payments" : "Live"],
    ...(report.details ?? []),
    ["Generated", `${generated} UTC${owner.generatedBy ? ` by ${owner.generatedBy}` : ""}`],
    []
  ];
  attach(reply, exportFilename(owner, report.file, periodFile));
  // The title block is written as rows of the same CSV, then a blank row, then the report's own table.
  return "﻿" + toCsv([], preamble).replace(/^\r\n/, "") + toCsv(report.headers, report.rows);
}
