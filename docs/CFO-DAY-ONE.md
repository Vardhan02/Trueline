# Day one for a finance lead

**Before (15 min, IT or you):** deploy per [DEPLOY.md](DEPLOY.md) and send the finance team the URL and password.

## Day one, about an hour

1. **Export three files from your accounting system** (names are examples):
   - Aged receivables or invoice list → CSV/XLSX. Include due date and amount outstanding if available.
   - Bank statement for the last 60–90 days → CSV, XLSX or OFX.
   - Monthly profit and loss for the last 12–24 months → CSV/XLSX.
2. **Data → drop all three in.** Confident files are read immediately. If asked, pick what the file is and match the columns.
3. **Check "Connected files".** Open any "notes" to see skipped rows and assumptions. Fix the export and re-upload (same file name replaces it).
4. **Settings:** company, currency, your email domain, cost of sales share and monthly overheads (the outlook uses these; defaults are placeholders).
5. **Read Overview, then Priorities.** Tap any line's evidence to see the file and row. If a number is wrong, the source row shows why.
6. Optionally drop in `.eml` files of customer replies and supplier notices.

## Every morning

Export a fresh invoice list and bank statement, re-upload (30 seconds), read the brief. Data older than your stale threshold is flagged.

## Know before relying on it

- Numbers come from your files only; stale files are marked. There is no bank connection, so the bank is only as current as the last upload.
- The outlook is seasonality arithmetic on your history. Two full years give a sturdier picture than one.
- Prepared messages are drafts: nothing is sent.
- Single shared password; no audit trail.
