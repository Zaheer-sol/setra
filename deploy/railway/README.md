# Deploying Setra on Railway

Four Railway services, one project: `Postgres` (Railway's database), `api` (the API; runs
migrations before each deploy), `worker` (watches Monad and delivers webhooks, always on) and `web`
(the console, the website and the hosted payment page). Nothing sleeps. The web app reaches the API
over Railway's private network, so the API needs no public address.

The service names matter: the variables refer to each other as `api`, `worker`, `web` and `Postgres`.

## One-time setup

1. Sign in at railway.com with GitHub and create a **New Project → Deploy from GitHub repo →
   Zaheer-sol/setra**. Railway creates one service from the repo; open it and rename it to `api`
   (Settings → Service name).
2. In the project, **Create → Database → PostgreSQL**. Leave its name as `Postgres`.
3. **Create → GitHub Repo → Zaheer-sol/setra** twice more, and rename the two new services `worker`
   and `web`.
4. For each of `api`, `worker` and `web`, open **Settings → Config-as-code** and set the Railway
   config file to `/deploy/railway/api.json`, `/deploy/railway/worker.json` or
   `/deploy/railway/web.json` respectively. Leave the root directory empty (the whole repository).
5. On `web`, open **Settings → Networking → Generate Domain**. This is the site's public address.
   `api` and `worker` need no domain.
6. On your computer, from the repository folder:

       npm install -g @railway/cli
       railway login
       railway link              # choose the Setra project
       bash deploy/railway/setup-variables.sh

   The script generates the secrets with openssl and sends them straight to Railway (they are never
   shown), and sets every other variable as a Railway reference, so the services find the database
   and each other by themselves. Running it again is safe: existing secrets are kept.
7. Deploy: in the Railway dashboard press **Deploy** on the staged changes, or push to GitHub.

The first deploy builds for a few minutes. `api` runs migrations, enables the restricted database
role the app connects as, and seeds the demo workspace (sign in as `owner@acme.test` with the demo
password from the README). Then open the `web` domain.

## After deploying the contracts

Once `contracts/deployments/monad-testnet.json` exists (see `contracts/deployments/README.md`), run
`bash deploy/railway/setup-variables.sh` again: it adds the contract addresses to `api` and `worker`.

## Why the app doesn't connect as the database's own user

Railway's Postgres user is a superuser, and superusers bypass row-level security, the database-level
wall between workspaces. The API's pre-deploy step runs migrations as that user, then enables the
`setra_app` role (no superuser, no bypass) with the generated `APP_DB_PASSWORD`, and the API and
worker connect as `setra_app`.

## Cost

Railway has no free always-on plan: after the trial credit it's the Hobby plan (a monthly fee that
includes some usage) plus usage above that. Check railway.com/pricing for current numbers.
