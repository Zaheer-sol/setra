# Security

Setra handles payment records, not money. It never holds funds, private keys or signing authority.

## Tenancy

- Every tenant table has `organization_id` and `environment`; every query filters by both.
- PostgreSQL row-level security enforces the organization boundary underneath the application.
  The API and worker connect as `setra_app`, a non-superuser without `BYPASSRLS`; migrations run as
  the schema owner. Tests assert the role's attributes and that an unfiltered query returns nothing.
- Cross-tenant scans are limited to the worker's wallet list and webhook queue (`app.system = on`).
- Other organizations' objects return `404`, never `403`, so ids can't be probed.

## Authentication and authorization

- Passwords: scrypt (N=2^15, r=8, p=1), per-password salt, constant-time comparison; login runs a
  dummy hash for unknown emails to avoid timing leaks.
- Sessions: 256-bit random tokens, stored hashed, `HttpOnly`, `SameSite=Lax`, `Secure` in production,
  14-day expiry, revoked on logout and on password reset.
- CSRF: cookie-authenticated mutations must carry the console's `Origin`. API-key requests are exempt.
- Password reset: single-use hashed tokens valid for one hour; responses don't reveal whether an
  account exists.
- Roles: owner, admin, operator, developer, viewer. Permissions are checked server-side on every route
  (`apps/api/src/lib/principal.ts`). Live API keys can only be created by owners/admins.

## API keys

`sk_test_…` / `sk_live_…`, 256-bit random, SHA-256 hashed at rest, shown once, revocable immediately,
read-only scope available, bound to one environment, audited on create/revoke, never usable to manage
keys, members or workspace settings.

## Webhooks

- HMAC-SHA256 over `timestamp.body`, `v1=` scheme, two signatures during 24h rotation.
- Secrets encrypted at rest with AES-256-GCM (`ENCRYPTION_KEY`) because they must be readable to sign.
- SSRF protection: in production, URLs must be HTTPS and resolve to public addresses (loopback,
  private, link-local, CGNAT and multicast ranges refused); redirects are not followed.
- Deliveries record every attempt (request headers, status, response excerpt, duration).

## Input, output and transport

- zod validation on every body, query and path parameter; decimal strings for money.
- Parameterized SQL only; `ILIKE` input is escaped.
- JSON responses with `nosniff`; the web app sends CSP, `X-Frame-Options: DENY`, `Referrer-Policy`.
- Errors never include stack traces; each has a `request_id`.
- CSV exports neutralize formula injection.
- Rate limiting per credential (300/min) and per IP on auth (20/min) and public pages (120/min).
  The limiter is in-memory: run a shared store (Redis) when running multiple API instances.

## Logging

Structured JSON with request ids. Authorization headers, cookies and password/secret/token fields are
redacted. Emails with secrets (reset links, invitations) are only logged in development when SMTP isn't
configured; production never logs them.

## Financial integrity

Evidence, decisions, allocations, events, resolutions, webhook attempts and audit logs are append-only
at the database level. See `docs/architecture.md#invariants-and-where-theyre-enforced`.

## Smart contract

See `docs/smart-contract.md`. Not audited.
