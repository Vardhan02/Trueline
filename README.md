# Trueline

A daily finance brief for owners and finance managers of small businesses. It pulls scattered finance files together, ranks what needs action, and **shows the source (file and row) for every line**. The niche is trust: a brief you can check in one tap.

## Quick start

```bash
npm ci
npm start                 # http://localhost:3000
```

Create an account, then drop files on your account page (or click **Load sample**). The brief builds itself. Click the **Trueline** logo any time to get back to your account: files, settings, connections and security.

Supported files: CSV/TSV, Excel `.xlsx`, bank `.ofx`/`.qfx`, emails `.eml`. Detail: [docs/DATA-FORMATS.md](docs/DATA-FORMATS.md).

## Run it properly (Docker)

```bash
cp .env.example .env      # set PUBLIC_URL, SESSION_SECRET and ENCRYPTION_KEY
docker compose up -d --build
curl localhost:3000/readyz
```

## Accounts and security

- Each person signs up with email and password and sees only their own files and connections.
- Passwords: salted **scrypt** hashes (never stored or logged in clear), 10+ characters, rate-limited sign-in, identical answers for unknown email and wrong password. Changing the password signs out every other device.
- Sign-up tells a visitor when an email already has an account (there is no email verification, so it cannot answer otherwise). Attempts are limited per IP address and per email. To stop strangers checking which emails are registered, set `SIGNUP_CODE` (invite code) or `ALLOW_SIGNUP=false` once your team has signed up.
- Sessions: HttpOnly, SameSite=Lax, Secure in production, HMAC-signed; CSRF header required on every change.
- Secrets at rest (Google refresh tokens, webhook addresses, inbound links): **AES-256-GCM** with `ENCRYPTION_KEY`. API keys are stored only as SHA-256 hashes and shown once.
- Data files are written with owner-only permissions (0600).

## Minimum manual work: connections

From the account page:

- **Google Calendar, Tasks and Docs**: bills and tax dates with reminders, today's actions as tasks, the brief as a living doc. Updates itself after every upload or forwarded email and every few hours. Setup: [docs/GOOGLE.md](docs/GOOGLE.md).
- **Inbound link**: forward bills, remittances and statements (raw email or files) from a mail-forwarding service, Zapier or Make. They are read, checked and synced with no clicks.
- **Webhooks**: the brief posted as signed JSON after every update, to reach Slack, Teams, Outlook, Notion or anything Zapier, Make or n8n can reach.
- **MCP and API**: give Claude, Cursor or another MCP client read-only access with a personal key (`/mcp`, tools: `get_brief`, `list_priorities`, `ask`, `cash_outlook`), or `GET /api/v1/brief`.

Full guide: [docs/DEPLOY.md](docs/DEPLOY.md). A CFO's first day: [docs/CFO-DAY-ONE.md](docs/CFO-DAY-ONE.md).

## Development

| Command                                            | What it does                                          |
| -------------------------------------------------- | ----------------------------------------------------- |
| `npm run dev`                                      | Start with auto-reload                                |
| `npm run lint`                                     | ESLint                                                |
| `npm run format` / `format:check`                  | Prettier                                              |
| `npm test`                                         | Unit and HTTP tests (`node:test`, no extra framework) |
| `npm run test:coverage`                            | Tests with coverage                                   |
| `npm run check`                                    | Lint + format check + tests (what CI runs)            |
| `INPUT=online_retail_II.xlsx npm run build:sample` | Rebuild the real-data sample                          |

Architecture and where to change things: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Honest limits

- Accounts are individual: there are no shared team workspaces or roles yet. Storage is JSON files on one server (fine for hundreds of users; use a database beyond that).
- Google sync is tested against a faithful fake of the Google APIs, not a live Google account. The first real connection needs the Google Cloud setup in docs/GOOGLE.md.
- There is no direct Gmail or Outlook mailbox connection: incoming email arrives through the inbound link.
- No live bank connection: bank data comes from uploaded statements.
- Pdf and legacy `.xls` files are refused with guidance.
- The bundled sample mixes real invoices and turnover with **simulated** payments, bank, emails and costs. Simulated files say so in their names.
- The Docker image is built and probed in CI; it has not been built locally (no Docker daemon where this was authored), so treat the first CI run as its first test.
- **Forecast accuracy (back-tested on real data):** on the Online Retail II sample, predicting each month of 2011 from what was known on the 1st gave a mean error of 12.8% over 8 months. With one year of history the range is deliberately wide (±25%); the actual landed inside it in 7 of 8 months. Run `npm run backtest`. Eight months of one business is a small sample: expect better with 3+ years of P&L, and do not treat the range as a guarantee.
- `dist/trueline-demo.html` (`npm run build:demo`) is a read-only static demo with the data baked in; it cannot take uploads.
