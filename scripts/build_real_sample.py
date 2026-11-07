#!/usr/bin/env python3
"""Build the "online-retail-ii" sample workspace from the UCI Online Retail II dataset (CC BY 4.0).

REAL:      invoice numbers, invoice dates, customer IDs, invoice totals, monthly turnover.
SIMULATED: payment terms, payment dates, the bank statement, supplier/payroll lines, inbox emails, cost settings.
Everything simulated is labelled "SIMULATED" in the file name so it shows in the product's source list.

Usage: python3 -I scripts/build_real_sample.py INPUT(.xlsx|.pkl) samples/online-retail-ii
Deterministic: the same input always produces the same files.
"""
import json
import random
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

import pandas as pd

AS_OF = date(2011, 11, 9)
LEDGER_FROM = date(2011, 8, 1)
TOP_CUSTOMERS = 14
SEED = 20111109


def load(path):
    if path.endswith('.pkl'):
        return pd.read_pickle(path)
    frames = pd.read_excel(path, sheet_name=None)
    return pd.concat(frames.values(), ignore_index=True)


def main(src, out):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    rnd = random.Random(SEED)
    df = load(src)
    df = df[~df['Invoice'].astype(str).str.startswith('C')]
    df = df[(df['Quantity'] > 0) & (df['Price'] > 0)].copy()
    df['value'] = df['Quantity'] * df['Price']
    df['day'] = df['InvoiceDate'].dt.date

    # --- P&L: real monthly turnover, 2010 full year + Jan-Oct 2011 ---
    df['month'] = df['InvoiceDate'].dt.strftime('%Y-%m')
    monthly = df.groupby('month')['value'].sum().round(0)
    monthly = monthly[(monthly.index >= '2010-01') & (monthly.index <= '2011-10')]
    pd.DataFrame({'Month': monthly.index, 'Turnover': monthly.values.astype(int)}).to_csv(out / 'pnl_monthly_turnover_REAL.csv', index=False)

    # --- Ledger: real invoices of the biggest trade customers, last ~14 weeks ---
    cust = df.dropna(subset=['Customer ID'])
    cust = cust[cust['day'] <= AS_OF]
    trailing = cust[cust['day'] >= AS_OF - timedelta(days=365)].groupby('Customer ID')['value'].sum().sort_values(ascending=False)
    top = list(trailing.head(TOP_CUSTOMERS).index)
    inv = (cust[(cust['Customer ID'].isin(top)) & (cust['day'] >= LEDGER_FROM)]
           .groupby(['Invoice', 'Customer ID']).agg(day=('day', 'min'), amount=('value', 'sum')).reset_index())
    inv['amount'] = inv['amount'].round(2)
    inv = inv[inv['amount'] >= 100].sort_values(['day', 'Invoice']).reset_index(drop=True)

    names = {c: 'Customer %d' % int(c) for c in top}
    terms = {c: rnd.choice([30, 30, 45, 60]) for c in top}
    slow = set(rnd.sample(top, 3))  # chronic late payers

    rows, bank_credits = [], []
    for _, r in inv.iterrows():
        c = r['Customer ID']
        issued = r['day']
        due = issued + timedelta(days=terms[c])
        roll = rnd.random()
        late_p = 0.55 if c in slow else 0.15
        if roll < late_p:
            delay = terms[c] + rnd.randint(6, 40)
        else:
            delay = terms[c] + rnd.randint(-4, 3)
        paid_on = issued + timedelta(days=delay)
        partial = rnd.random() < 0.03 and r['amount'] > 1000
        ledger_lag = (AS_OF - paid_on).days in (0, 1, 2) and paid_on <= AS_OF  # bank has it, ledger not yet updated
        status, owed = 'Open', r['amount']
        if paid_on <= AS_OF:
            amt = round(r['amount'] * 0.6, 2) if partial else r['amount']
            bank_credits.append({'date': paid_on, 'customer': names[c], 'invoice': str(r['Invoice']), 'amount': amt,
                                 'with_ref': rnd.random() < 0.75})
            if not ledger_lag and not partial:
                status, owed = 'Paid', 0.0
            elif partial and not ledger_lag:
                owed = round(r['amount'] - amt, 2)
        rows.append({'Invoice No': 'INV-%s' % r['Invoice'], 'Customer': names[c], 'Invoice Date': issued.isoformat(),
                     'Due Date': due.isoformat(), 'Amount': '%.2f' % r['amount'], 'Amount Outstanding': '%.2f' % owed, 'Status': status})
    pd.DataFrame(rows).to_csv(out / 'ar_ledger_REAL_invoices.csv', index=False)

    # --- Bank statement (SIMULATED): customer receipts + supplier, payroll, rent lines ---
    lines = []
    for b in bank_credits:
        ref = ' ' + 'INV-' + b['invoice'] if b['with_ref'] else ''
        lines.append((b['date'], 'FASTER PAYMENT %s%s' % (b['customer'].upper(), ref), 0.0, b['amount']))
    # Everyone outside the ledger customers (web-shop and small trade buyers) settles through the card processor, weekly.
    rest = df[(df['day'] >= LEDGER_FROM) & (df['day'] <= AS_OF) & (~df['Customer ID'].isin(top))].copy()
    rest['week'] = rest['InvoiceDate'].dt.to_period('W-SUN').apply(lambda p: p.end_time.date())
    for wk, v in rest.groupby('week')['value'].sum().items():
        settle = wk + timedelta(days=2)
        if settle <= AS_OF:
            lines.append((settle, 'CARD PROCESSOR SETTLEMENT', 0.0, round(float(v) * 0.97, 2)))
    d = date(2011, 8, 1)
    while d <= AS_OF:
        if d.day == 25:
            lines.append((d, 'PAYROLL', 78000.0, 0.0))
        if d.day == 1:
            lines.append((d, 'DD WAREHOUSE RENT', 18500.0, 0.0))
        if d.weekday() == 4:
            week_sales = float(df[(df['day'] > d - timedelta(days=7)) & (df['day'] <= d)]['value'].sum())
            lines.append((d, 'BACS SUPPLIER BATCH', round(week_sales * 0.62 * rnd.uniform(0.9, 1.1), 2), 0.0))
        d += timedelta(days=1)
    lines.sort(key=lambda x: (x[0], x[1]))
    balance = 260000.0
    out_rows = []
    for dt, desc, debit, credit in lines:
        balance = round(balance - debit + credit, 2)
        out_rows.append({'Date': dt.strftime('%d/%m/%Y'), 'Description': desc, 'Debit': '%.2f' % debit if debit else '', 'Credit': '%.2f' % credit if credit else '', 'Balance': '%.2f' % balance})
    pd.DataFrame(out_rows).to_csv(out / 'bank_statement_SIMULATED.csv', index=False)

    # --- Inbox (SIMULATED): four emails written around real ledger rows ---
    ledger = pd.DataFrame(rows)
    openrows = ledger[ledger['Status'] == 'Open'].copy()
    openrows['due'] = pd.to_datetime(openrows['Due Date']).dt.date
    overdue = openrows[openrows['due'] < AS_OF].sort_values('Amount', key=lambda s: s.astype(float), ascending=False)
    lagging = ledger[(ledger['Status'] == 'Open') & (ledger['Amount Outstanding'].astype(float) == ledger['Amount'].astype(float))]
    mails = []

    def eml(name, frm, to, when, subject, body):
        text = 'From: %s\nTo: %s\nDate: %s\nSubject: %s\nMessage-ID: <%s@sample.invalid>\nContent-Type: text/plain; charset=utf-8\n\n%s\n' % (frm, to, when.strftime('%a, %d %b %Y %H:%M:%S +0000'), subject, name, body)
        (out / name).write_text(text, encoding='utf-8')
        mails.append(name)

    own = 'accounts@giftware-sample.example'
    if len(overdue) >= 3:
        a, b, c = overdue.iloc[0], overdue.iloc[1], overdue.iloc[2]
        eml('inbox_SIMULATED_1_remittance.eml', 'ap@customer-a.example', own, datetime(2011, 11, 7, 10, 5), 'Remittance advice %s' % a['Invoice No'],
            "Hello,\n\nWe've released payment of £%s for %s today.\n\nKind regards,\nAccounts Payable" % ('{:,.2f}'.format(float(a['Amount Outstanding'])), a['Invoice No']))
        eml('inbox_SIMULATED_2_promise.eml', 'ap@customer-b.example', own, datetime(2011, 11, 8, 15, 40), 'Re: %s' % b['Invoice No'],
            "Hi,\n\nApologies for the delay on %s. We will pay this on Friday.\n\nThanks,\nFinance" % b['Invoice No'])
        eml('inbox_SIMULATED_3_chase_sent.eml', own, 'ap@customer-c.example', datetime(2011, 11, 4, 9, 30), 'Reminder: %s is overdue' % c['Invoice No'],
            "Hi,\n\nA quick reminder that %s (£%s) was due on %s and is still unpaid. Could you confirm when we can expect payment?\n\nThanks,\nFinance team" % (c['Invoice No'], '{:,.2f}'.format(float(c['Amount Outstanding'])), c['due'].strftime('%d %b')))
    if len(lagging):
        e = lagging.iloc[-1]
        eml('inbox_SIMULATED_4_newsletter.eml', 'news@fintechweekly.example', own, datetime(2011, 11, 8, 8, 0), 'Fintech weekly digest', 'Top stories this week: payment rails, open banking and a new funding round. Read more online.')

    manifest = {
        'title': 'Real UK wholesaler invoices (Online Retail II)',
        'description': 'Real invoice numbers, dates, customers, amounts and monthly turnover from the UCI Online Retail II dataset (CC BY 4.0), as of 9 Nov 2011. '
                       'Payment terms, payments, the bank statement, emails and cost settings are SIMULATED and labelled as such in the file names.',
        'settings': {'company': 'Online Retail Co (sample)', 'currency': 'GBP', 'asOf': AS_OF.isoformat(), 'costOfSalesPct': 0.66, 'overheadsMonthly': 120000,
                     'staleDays': 7, 'termsDays': 30, 'emailDomain': 'giftware-sample.example'},
        'files': [{'file': 'ar_ledger_REAL_invoices.csv', 'kind': 'ledger'}, {'file': 'bank_statement_SIMULATED.csv', 'kind': 'bank'},
                  {'file': 'pnl_monthly_turnover_REAL.csv', 'kind': 'pnl'}] + [{'file': m, 'kind': 'emails'} for m in mails],
    }
    (out / 'sample.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    print('ledger rows %d (open %d), bank lines %d, emails %d, months %d' % (len(rows), (ledger['Status'] == 'Open').sum(), len(out_rows), len(mails), len(monthly)))


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
