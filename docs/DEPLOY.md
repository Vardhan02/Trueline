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

## Operations

- **Health:** `/healthz` (process up), `/readyz` (data dir reachable). Docker's healthcheck uses `/readyz`.
- **Logs:** JSON lines on stdout (pino). Cookies and auth headers are redacted. Each response carries `X-Request-Id`.
- **Backup:** copy `workspace.json`. It holds the uploaded finance records, so protect it like the source files.
- **Upgrade:** `git pull && docker compose up -d --build`. The data file format is backward compatible within a major version.
- **Shutdown:** SIGTERM drains requests, then exits (10s limit).
- **Limits:** `MAX_UPLOAD_MB` (default 10), 50 sources, upload and login rate limits.

## Security notes

One shared password, no per-user accounts, no audit log. Fine for a single finance team; not for multi-company hosting. Data is stored unencrypted on the volume: use disk encryption.

## One-click hosting (Render)

`render.yaml` is a blueprint: Render → New → Blueprint → pick the repo. It builds the Dockerfile, mounts a 1 GB disk at `/data`, generates `SESSION_SECRET` and `ENCRYPTION_KEY`, and asks for `PUBLIC_URL` (your `https://….onrender.com` address) and, optionally, the Google client. Health check is `/readyz`. A persistent disk requires a paid plan.

## Static demo

`npm run build:demo` writes `dist/trueline-demo.html`, one self-contained file you can host anywhere (or open from disk). Read-only.

## Backups and keys

Back up the data folder (`accounts.json` and `users/`) and keep `ENCRYPTION_KEY` somewhere safe and separate. Without that key the stored Google tokens and webhook addresses cannot be read (users would reconnect); passwords and files are unaffected. Upgrading from the single-password version: the first account created takes over the old workspace automatically.
