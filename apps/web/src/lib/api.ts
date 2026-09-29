"use client";

import useSWR, { type SWRConfiguration } from "swr";

/** Errors from the Setra API, carrying the server's code, message and request id. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
    readonly details?: Array<{ field: string; message: string }>
  ) {
    super(message);
  }
}

/** All console traffic goes through the same-origin /api proxy with the session cookie. */
export async function api<T = any>(path: string, init: { method?: string; body?: unknown; idempotencyKey?: string } = {}): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.idempotencyKey) headers["idempotency-key"] = init.idempotencyKey;
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body), credentials: "same-origin", cache: "no-store" });
  } catch {
    throw new ApiError(0, "network_error", "Can't reach Setra. Check your connection and try again.");
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const e = data?.error;
    if (res.status === 502 || res.status === 503 || res.status === 504 || (!e && res.status >= 500)) {
      throw new ApiError(res.status, "api_unavailable", "The Setra API isn't responding. Your data is safe. Try again in a moment.");
    }
    throw new ApiError(res.status, e?.code ?? "error", e?.message ?? "Something went wrong.", e?.request_id, e?.details);
  }
  return data as T;
}

export function useApi<T = any>(path: string | null, config?: SWRConfiguration) {
  const swr = useSWR<T, ApiError>(path, (p: string) => api<T>(p), { revalidateOnFocus: true, shouldRetryOnError: (err) => err.status >= 500 || err.status === 0, errorRetryCount: 3, ...config });
  return { ...swr, loading: !swr.data && !swr.error };
}

export const newIdempotencyKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

export function qs(params: Record<string, string | number | undefined | null | false>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "" && v !== false) u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : "";
}
