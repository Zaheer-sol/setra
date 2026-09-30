# Deploying Setra on Railway

One Railway project with four services: a PostgreSQL database, the API (runs migrations when it
starts), the worker (watches Monad and delivers webhooks, always on) and the web app (console,
website and hosted payment page). Nothing sleeps. The web app reaches the API over Railway's private
network, so the API needs no public address.

All three app services build the same Docker image from this repository (the Dockerfile's default
stage, as `railway.json` at the root says), and each one's `SETRA_ROLE` variable (`api`, `worker` or
`web`) decides what starts, so there's no per-service configuration in the dashboard. The API runs
migrations each time it starts.

## One-time setup

From the repository folder:

    npm install -g @railway/cli
    railway login
    railway link                     # choose the project

Create the database and the services (skip any that already exist; a service created from the repo
in the dashboard works too, whatever its name):

    railway add --database postgres
    railway add --service api --repo Zaheer-sol/setra
    railway add --service worker --repo Zaheer-sol/setra
    railway add --service web --repo Zaheer-sol/setra

Then set everything up:

    bash deploy/railway/setup-variables.sh

The script gives the web service a public address, generates the secrets with openssl and sends them
straight to Railway (they are never shown), and sets every other variable as a Railway reference so
the services find the database and each other by themselves. It prints the site's address at the
end. Running it again is safe: existing secrets are kept.

If your services have other names, say so: `API_SERVICE=setra bash deploy/railway/setup-variables.sh`
(also `WORKER_SERVICE`, `WEB_SERVICE` and `DB_SERVICE`; the defaults are `api`, `worker`, `web` and
`Postgres`).

Finally, deploy: `railway up --service <name> --detach` for each service uploads this folder (files in
`.gitignore`, such as `.env`, are never uploaded), or connect the services to the GitHub repo in the
dashboard so every push deploys. The first build takes a few minutes.
The API runs migrations, enables the restricted database role the app connects as, and seeds the demo
workspace (sign in as `owner@acme.test` with the demo password from the README).

## After deploying the contracts

Once `contracts/deployments/monad-testnet.json` exists (see `contracts/deployments/README.md`), run
the setup script again: it adds the contract addresses to the API and the worker.

## Why the app doesn't connect as the database's own user

Railway's Postgres user is a superuser, and superusers bypass row-level security, the database-level
wall between workspaces. The API's pre-deploy step runs migrations as that user, then enables the
`setra_app` role (no superuser, no bypass) with the generated `APP_DB_PASSWORD`, and the API and
worker connect as `setra_app`.

## Cost

Railway has no free always-on plan: after the trial credit it's the Hobby plan (a monthly fee that
includes some usage) plus usage above that. Check railway.com/pricing for current numbers.
