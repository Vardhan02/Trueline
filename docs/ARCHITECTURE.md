# Architecture

```
upload ──> ingest ──> workspace.json ──> buildDataset ──> engine ──> UI
 (file)   detect +     (atomic JSON)     (pure function)  (rules)   (browser)
          normalise
```

The key rule: **no language model decides what is true.** Everything shown is produced by plain rules over your records, and each line cites a record.

| Folder                 | Role                                                                                                                                                                                                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/ingest/`          | Read files (`tabular`, `ofx`, `eml`), guess what they are (`detect`), turn rows into records plus a list of problems (`normalize`), pull payment claims from emails with exact quotes (`extract`), assemble engine input (`build`). `index.js` exposes `inspect` (look, save nothing) and `ingest` (convert). |
| `src/engine/engine.js` | The brief. Facts → grouped by invoice → trust state (agree / record / conflict / single / stale) → score → numbers. Evidence order: bank > ledger > sheets > email. Also the seasonality forecast. Runs in Node and in the browser (same file).                                                               |
| `src/store/`           | One JSON file, written atomically, updates queued so uploads cannot overwrite each other.                                                                                                                                                                                                                     |
| `src/app.js`           | Express routes, security headers, CSRF header check, rate limits, error mapping.                                                                                                                                                                                                                              |
| `src/auth.js`          | Per-user signed, expiring session cookie. No session table.                                                                                                                                                                                                                                                   |
| `src/config.js`        | Reads environment once; production refuses to start without password and secret.                                                                                                                                                                                                                              |
| `public/`              | Plain HTML/CSS/JS, no build step. Loads `/api/dataset` and runs the engine in the browser.                                                                                                                                                                                                                    |
| `samples/`             | Sample workspaces. `online-retail-ii/` is built by `scripts/build_real_sample.py`.                                                                                                                                                                                                                            |

## Design choices

- **Two-step upload.** `inspect` shows what we think a file is; confident files are saved straight away, unsure ones ask the user to match columns. Nothing is guessed silently: skipped rows and assumptions are listed per file.
- **Deterministic.** `buildDataset(workspace, {clock})` is pure; tests inject the clock.
- **Everything has a source.** Each record keeps its file name and row number; the UI's "View source" shows them.
- **Fail loudly at start, gracefully at runtime.** Bad config exits with a message; bad files return a 422 with advice; unexpected errors return a request id and are logged.

## Known weak spots

- `.xlsx` is parsed in-process; size limits are the main protection against hostile files.
- Bank debits are not yet passed to the engine (receipts matching and balance only).
- Header detection uses English names. Other languages need column mapping by hand.
- Engine display settings are module-level (one workspace per process).

## Accounts and connections

- `src/security.js`: scrypt password hashing, AES-256-GCM vault for stored secrets, token helpers, password rules.
- `src/store/accountStore.js`: `accounts.json`, atomic writes, one change at a time. Each account's files live in `users/<id>/workspace.json`.
- `src/store/snapshot.js`: reads are served from a parsed, frozen copy that is reused while the file is unchanged (checked with `fs.stat` on every read, so outside edits are seen). Accounts are indexed by id, email, API-key hash and inbound-link hash; the 16 most recently used workspaces are kept. Writers always start from a fresh read of the file.
- `src/auth.js`: signed session cookie `userId.expiry.sessionVersion.signature`; OAuth `state` signing.
- `src/integrations/plan.js` (pure): engine → calendar events, tasks, doc text, each with a key and hash.
- `src/integrations/google.js`: thin fetch client for OAuth, Calendar, Tasks, Docs.
- `src/integrations/sync.js`: reconciles the plan with what was created last time (create, update, close; recreate if deleted), posts signed webhooks. Triggered after uploads, inbound mail, settings changes, and on a timer.
- `src/integrations/mcp.js`: read-only MCP tools over JSON-RPC, authorised by a personal API key.
- `src/integrations/netguard.js`: webhooks are sent through a DNS lookup that refuses private, loopback and link-local addresses at connect time, so a public name pointing at an internal address (or one that changes later) cannot be used to reach the server's network.
- `src/context.js`: wires it all together (tests pass a fake `http` for Google).
