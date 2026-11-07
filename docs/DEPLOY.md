# Deploying Trueline

## Requirements

A machine that runs Docker (or Node 22), and a way to serve it over HTTPS (reverse proxy such as Caddy, nginx, or your cloud load balancer). Trueline sets secure cookies in production, so it **must** sit behind HTTPS.

## Docker Compose

1. `cp .env.example .env`
2. Set `PUBLIC_URL`, `SESSION_SECRET` and `ENCRYPTION_KEY` (generate each with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`). Optionally `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` (docs/GOOGLE.md). After your team has signed up, set `ALLOW_SIGNUP=false` or use `SIGNUP_CODE`.
3. `docker compose up -d --build`
4. Check: `curl localhost:3000/readyz` → `{"status":"ready"}`

Data lives in the `trueline-data` volume (`/data/workspace.json`).

## Without Docker

`npm ci --omit=dev && NODE_ENV=production PUBLIC_URL=https://... SESSION_SECRET=... ENCRYPTION_KEY=... DATA_DIR=/var/lib/trueline node src/server.js`

## Caddy example

```
trueline.example.com {
  reverse_proxy localhost:3000
}
```

Sign-in limits are counted per visitor address. Trueline reads that address from `X-Forwarded-For` only when the request comes from a proxy on the same machine or a private network, which covers Caddy or nginx on localhost, Docker networks and cloud load balancers. If your proxy reaches Trueline from a public address, set `TRUST_PROXY` to its address or to the number of proxy hops.

## Operations

- **Health:** `/healthz` (process up), `/readyz` (data dir reachable). Docker's healthcheck uses `/readyz`.
- **Logs:** JSON lines on stdout (pino). Cookies and auth headers are redacted. Each response carries `X-Request-Id`.
- **Backup:** copy the whole data folder (`accounts.json` and `users/`); see [Backups and keys](#backups-and-keys). It holds the uploaded finance records, so protect it like the source files.
- **Upgrade:** `git pull && docker compose up -d --build`. The data file format is backward compatible within a major version.
- **Shutdown:** SIGTERM drains requests, then exits (10s limit).
- **Limits:** `MAX_UPLOAD_MB` (default 10) per file, 50 sources, upload, sign-in and sign-up rate limits (sign-up also per email). The inbound link takes up to 25 MB per request (each file still within `MAX_UPLOAD_MB`, at most 10 files) and reads two requests at a time; others wait their turn.

## Security notes

Individual accounts with their own files and connections; no shared team workspaces, roles or audit log yet. Uploaded files are stored unencrypted on the volume (only Google tokens and webhook addresses are encrypted): use disk encryption.

## One-click hosting (Render)

`render.yaml` is a blueprint: Render → New → Blueprint → pick the repo. It builds the Dockerfile, mounts a 1 GB disk at `/data`, generates `SESSION_SECRET` and `ENCRYPTION_KEY`, and asks for `PUBLIC_URL` (your `https://….onrender.com` address) and, optionally, the Google client. Health check is `/readyz`. A persistent disk requires a paid plan.

## Vercel

Vercel runs the app as short-lived functions with no lasting disk, so Trueline keeps its data in Postgres there. Setting `DATABASE_URL` switches storage from files to Postgres; Docker, Render and `npm start` keep using files when it is not set.

1. **Database.** In the Vercel dashboard open the project → **Storage** → **Create Database** → **Neon** (Postgres), and connect it to the project. This sets `DATABASE_URL` for you. Tables are created on the first request.
2. **Secrets.** Add these environment variables (Production and Preview): `SESSION_SECRET` and `ENCRYPTION_KEY` (32+ random characters each; `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`) and `CRON_SECRET` (any long random string; Vercel sends it to the daily sync). `PUBLIC_URL` defaults to the project's production address; set it if you use your own domain. Add the Google client variables if you use Google.
3. **Deploy.** Connect the Git repository in Vercel, or run `npx vercel deploy --prod`. `vercel.json` serves `public/` from the CDN (with the same security headers as the app) and sends everything else to `api/index.js`.

What is different on Vercel:

- **Uploads are limited to 4 MB** per file and per inbound request (Vercel caps requests at 4.5 MB). A 4 MB CSV holds about 80,000 invoice rows.
- **Background sync** runs straight after each upload, settings change or forwarded email, and once a day for everyone (`/cron/sync` at 06:00 UTC; the Hobby plan allows one cron run a day). The 6-hourly `SYNC_HOURS` timer only applies to long-running servers.
- **Several instances run at once**, so sign-in limits, account changes, workspace updates and Google syncs are coordinated through Postgres instead of in memory.
- `npm run test:pg` runs the whole test suite against Postgres (in-process PGlite), the same storage code Vercel uses.

## Static demo

`npm run build:demo` writes `dist/trueline-demo.html`, one self-contained file you can host anywhere (or open from disk). Read-only.

## Backups and keys

Back up the data folder (`accounts.json` and `users/`) and keep `ENCRYPTION_KEY` somewhere safe and separate. Without that key the stored Google tokens and webhook addresses cannot be read (users would reconnect); passwords and files are unaffected. Upgrading from the single-password version: the first account created takes over the old workspace automatically.
