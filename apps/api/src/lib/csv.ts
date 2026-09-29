import type { FastifyReply } from "fastify";
import { today } from "./dates";

/** RFC 4180 CSV with formula-injection protection (cells starting with = + - @ are prefixed with '). */
export function toCsv(headers: string[], rows: Array<Array<string | number | null | undefined>>): string {
  const cell = (v: string | number | null | undefined) => {
    if (v === null || v === undefined) return "";
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.map(cell).join(","), ...rows.map((r) => r.map(cell).join(","))].join("\r\n") + "\r\n";
}

/** Send rows as a CSV download named setra-{name}-{date}.csv. */
export function sendCsv(reply: FastifyReply, name: string, headers: string[], rows: Array<Array<string | number | null | undefined>>) {
  reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", `attachment; filename="setra-${name}-${today()}.csv"`);
  return toCsv(headers, rows);
}
