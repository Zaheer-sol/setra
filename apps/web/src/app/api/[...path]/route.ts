/**
 * Same-origin proxy from the browser to the Setra API.
 *
 * The target is read from API_INTERNAL_URL at request time (not frozen at build time like a
 * next.config rewrite), so one web image can be deployed in front of any API host. Cookies,
 * Origin (CSRF check), Authorization, Idempotency-Key and client IP headers are forwarded;
 * Set-Cookie headers are passed back so the session cookie stays first-party.
 */
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HOP_BY_HOP = new Set(["host", "connection", "content-length", "transfer-encoding", "keep-alive", "upgrade", "proxy-connection", "te", "trailer"]);

async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const base = (process.env.API_INTERNAL_URL ?? "http://localhost:4000").replace(/\/$/, "");
  const { path } = await context.params;
  const target = `${base}/${path.map(encodeURIComponent).join("/")}${request.nextUrl.search}`;

  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) headers.set(key, value);
  });

  const hasBody = !["GET", "HEAD"].includes(request.method);
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body: hasBody ? await request.arrayBuffer() : undefined,
      redirect: "manual",
      cache: "no-store"
    });
  } catch {
    return Response.json({ error: { code: "api_unavailable", message: "The Setra API isn't reachable right now. Your data is safe. Try again in a moment." } }, { status: 502 });
  }

  const responseHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (k === "set-cookie" || k === "content-encoding" || k === "content-length" || HOP_BY_HOP.has(k)) return;
    responseHeaders.set(key, value);
  });
  for (const cookie of upstream.headers.getSetCookie()) responseHeaders.append("set-cookie", cookie);
  return new Response(upstream.status === 204 ? null : upstream.body, { status: upstream.status, headers: responseHeaders });
}

export { proxy as GET, proxy as POST, proxy as PUT, proxy as PATCH, proxy as DELETE };
