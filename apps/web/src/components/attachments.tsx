"use client";

import { useRef, useState } from "react";
import { FileText, Paperclip, X } from "lucide-react";
import { Button, Card, useToast } from "@/components/app-ui";
import { useSession } from "@/components/session";
import { api, useApi, type ApiError } from "@/lib/api";
import { timeAgo } from "@/lib/format";

const TYPES: Record<string, string> = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", csv: "text/csv", txt: "text/plain" };
const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

async function toBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Receipts and supporting documents on a record. Files are kept with the books. */
export function Attachments({ objectType, objectId, title = "Receipts & documents" }: { objectType: "bill" | "expense" | "journal_entry" | "vendor"; objectId: string; title?: string }) {
  const { can } = useSession();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const { data, mutate } = useApi<{ data: any[] }>(`/v1/attachments?object_type=${objectType}&object_id=${objectId}`);
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    try {
      for (const file of Array.from(files)) {
        const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
        const type = TYPES[ext] ?? file.type;
        if (!Object.values(TYPES).includes(type)) throw new Error(`${file.name}: attach a PDF, image, CSV or text file.`);
        if (file.size > 10 * 1024 * 1024) throw new Error(`${file.name} is over 10 MB.`);
        await api("/v1/attachments", { method: "POST", body: { object_type: objectType, object_id: objectId, filename: file.name, content_type: type, data_base64: await toBase64(file) } });
      }
      toast("success", files.length === 1 ? "File attached." : `${files.length} files attached.`);
      mutate();
    } catch (e) {
      toast("error", (e as ApiError).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };
  const remove = async (id: string) => {
    try {
      await api(`/v1/attachments/${id}`, { method: "DELETE" });
      mutate();
    } catch (e) {
      toast("error", (e as ApiError).message);
    }
  };
  return (
    <Card
      title={title}
      actions={
        can("financials:write") ? (
          <>
            <input ref={input} type="file" multiple accept=".pdf,.png,.jpg,.jpeg,.webp,.csv,.txt" className="hidden" onChange={(e) => upload(e.target.files)} />
            <Button size="sm" icon={<Paperclip />} loading={busy} onClick={() => input.current?.click()}>
              Attach
            </Button>
          </>
        ) : undefined
      }
    >
      {!data || data.data.length === 0 ? (
        <p className="px-6 py-4 text-sm text-muted-foreground max-md:px-4">No files yet. Attach the receipt or invoice so the record explains itself.</p>
      ) : (
        <ul className="divide-y">
          {data.data.map((a) => (
            <li key={a.id} className="flex items-center gap-3 px-6 py-2.5 max-md:px-4">
              <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <a href={`/api/v1/attachments/${a.id}/download`} className="min-w-0 flex-1 truncate text-sm font-medium text-primary hover:underline" download>
                {a.filename}
              </a>
              <span className="shrink-0 text-xs text-muted-foreground">{size(a.size_bytes)} · {timeAgo(a.created_at)}</span>
              {can("financials:write") && (
                <Button size="sm" variant="ghost" icon={<X />} aria-label={`Remove ${a.filename}`} onClick={() => remove(a.id)} />
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
