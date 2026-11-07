# Connecting Google Calendar, Tasks and Docs

Done once by whoever runs the server. After that, each user clicks **Connect Google** on their account page.

## What Trueline does in a user's Google account

| Where    | What                                                                                                                                                               | Updated                                                                        |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Calendar | A calendar called **Trueline**: bills and tax due in the next 60 days (reminders 3 days and 1 day before) and the 15 largest payments expected in the next 30 days | After every upload, forwarded email or settings change, and every `SYNC_HOURS` |
| Tasks    | A task list called **Trueline**: today's actions (Google Reminders now live in Tasks). Finished or no-longer-needed tasks are ticked off, never deleted.           | Same                                                                           |
| Docs     | One doc, **Trueline brief · Company**, rewritten with the latest brief and upcoming dates                                                                          | Only when the brief changes                                                    |

Each item is matched by a stable key and a content hash, so a sync touches only what changed. If the user deletes an event, the calendar or the doc, the next sync puts it back.

## Scopes (least privilege)

- `calendar.app.created`: only calendars Trueline creates. It cannot read the user's other calendars.
- `tasks`: Google Tasks.
- `drive.file`: only files Trueline creates. It cannot read the user's other docs.
- `openid email`: to show which Google account is connected.

No Gmail access. Incoming emails reach Trueline through the user's **inbound link** instead (see the account page).

## Server setup (about 10 minutes)

1. Google Cloud Console → create a project (for example `trueline`).
2. **APIs & Services → Library**: enable **Google Calendar API**, **Google Tasks API**, **Google Docs API**.
3. **Google Auth Platform → Branding**: app name `Trueline`, support email, your domain under authorised domains.
4. **Audience**: User type **External**. While in **Testing**, add each user's Google address as a test user (up to 100). Refresh tokens of apps in Testing expire after 7 days; publish the app to avoid that. `tasks` and `calendar.app.created` are sensitive scopes, so publishing for the public requires Google's verification.
5. **Data access**: add the five scopes above.
6. **Clients → Create client → Web application**:
   - Authorised redirect URI: `https://YOUR-DOMAIN/api/google/callback` (must equal `PUBLIC_URL` + `/api/google/callback`).
7. Copy the client ID and secret into `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, restart.

Refresh tokens are stored encrypted (AES-256-GCM, key from `ENCRYPTION_KEY`). Disconnecting or deleting the account revokes them at Google.
