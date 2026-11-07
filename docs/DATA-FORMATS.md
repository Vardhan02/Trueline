# What you can upload

| Kind                        | Files                       | Needs at minimum                                                      | Better with                                  |
| --------------------------- | --------------------------- | --------------------------------------------------------------------- | -------------------------------------------- |
| Invoices and bills (ledger) | CSV, XLSX                   | invoice number, customer/supplier, amount, and an invoice or due date | due date, status or amount outstanding       |
| Bank                        | CSV, XLSX, OFX/QFX          | date and amount (or credit + debit columns)                           | balance column, reference/description        |
| Monthly profit and loss     | CSV, XLSX                   | month and turnover (long list, or months across the top)              | at least one full year plus the year to date |
| Email                       | `.eml` (one file per email) |                                                                       | your email domain set in Settings            |

Not supported: PDF, legacy `.xls` (save as `.xlsx`/`.csv`), zip archives.

## What we handle

UTF-8 and Windows-1252 text; `,` `;` tab delimiters; title rows above the header; `1,234.50` and `1.234,50`; `(500)` negatives; `£ € $`; `DD/MM/YYYY`, `YYYY-MM-DD`, `9 Nov 2026`, Excel dates; bank files newest- or oldest-first.

## What we do with problems

Rows we cannot read are skipped and listed (first 25, with line numbers). Assumptions are stated: missing due date → invoice date + your terms; no status column → treated as unpaid; credit notes ignored; repeated invoice numbers → last one wins.

## Emails

A claim is created only when a sentence names a known invoice number (or follows one in the same email). The quote is that exact sentence. Recognised: payment made, promise to pay (resolves "Friday"), supplier notices, reminders you sent. Everything else is ignored rather than guessed.
