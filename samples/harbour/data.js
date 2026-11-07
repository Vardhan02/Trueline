(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TRUELINE_DATA = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // Seeded demo data. Fictional company. "extracted" blocks are what the LLM extraction step produces
  // from each email; "quote" must be an exact sentence from the email body (checked in test.js).
  return {
    COMPANY: 'Harbour & Co Ltd',
    CURRENCY: 'EUR',
    NOW: '2026-11-09T06:30:00Z',
    LAST_BRIEF_AT: '2026-11-06T06:30:00Z',

    SOURCES: {
      ledger:   { id: 'ledger',   type: 'ledger', name: 'Accounting ledger',  short: 'ledger',           file: 'ledger_export.csv',            syncedAt: '2026-11-09T06:00:00Z' },
      tracker:  { id: 'tracker',  type: 'sheet',  name: 'Payments tracker',   short: 'payments tracker', file: 'payments_tracker.xlsx',        syncedAt: '2026-11-08T17:40:00Z' },
      vat:      { id: 'vat',      type: 'sheet',  name: 'VAT workings',       short: 'VAT workings',     file: 'vat_workings_sep_oct.xlsx',    syncedAt: '2026-11-08T11:15:00Z' },
      forecast: { id: 'forecast', type: 'sheet',  name: 'Cash forecast',      short: 'cash forecast',    file: 'cash_forecast_q4.xlsx',        syncedAt: '2026-10-29T09:20:00Z' },
      bank:     { id: 'bank',     type: 'bank',   name: 'Bank feed',          short: 'bank',            file: 'bank_feed (open banking)',     syncedAt: '2026-11-09T06:10:00Z' },
      pnl:      { id: 'pnl',      type: 'sheet',  name: 'P&L workings',       short: 'P&L',             file: 'pnl_workings.xlsx',            syncedAt: '2026-11-05T10:00:00Z' },
      history:  { id: 'history',  type: 'log',    name: 'Action log',         short: 'action log',      file: 'action_log.csv',               syncedAt: '2026-11-09T06:00:00Z' },
      inbox:    { id: 'inbox',    type: 'email',  name: 'finance@ inbox',     short: 'email',            file: 'finance@harbourco.ie',         syncedAt: '2026-11-09T06:00:00Z' }
    },

    LEDGER: [
      { id: 'INV-1042', type: 'receivable', party: 'Acme Ltd',          amount: 18400, issued: '2026-10-02', due: '2026-11-01', status: 'open', row: 12 },
      { id: 'INV-1017', type: 'receivable', party: 'Brightwave Ltd',    amount: 9800,  issued: '2026-09-26', due: '2026-10-26', status: 'open', row: 7 },
      { id: 'INV-1055', type: 'receivable', party: 'Kestrel Foods',     amount: 6250,  issued: '2026-10-21', due: '2026-11-20', status: 'open', row: 15 },
      { id: 'INV-1029', type: 'receivable', party: 'Marlow Design',     amount: 4100,  issued: '2026-10-06', due: '2026-11-05', status: 'open', row: 10 },
      { id: 'INV-1033', type: 'receivable', party: 'Northgate Ltd',     amount: 3200,  issued: '2026-10-05', due: '2026-11-04', status: 'open', row: 11 },
      { id: 'INV-1008', type: 'receivable', party: 'Delta Retail',      amount: 5600,  issued: '2026-09-10', due: '2026-10-10', status: 'paid', row: 4 },
      { id: 'BILL-221', type: 'payable',    party: 'Stellar Packaging', amount: 7900,  issued: '2026-10-13', due: '2026-11-12', status: 'open', row: 31 },
      { id: 'BILL-224', type: 'payable',    party: 'Corvid Logistics',  amount: 2150,  issued: '2026-10-28', due: '2026-11-28', status: 'open', row: 33 }
    ],

    TRACKER: [
      { row: 8,  date: '2026-10-12', payer: 'Delta Retail', ref: 'INV-1008', amount: 5600 },
      { row: 14, date: '2026-11-06', payer: 'Marlow Design', ref: 'INV-1029', amount: 4000 }
    ],

    // Live bank feed. Strongest evidence in the system: it shows what actually arrived.
    BANK: {
      syncedAt: '2026-11-09T06:10:00Z',
      balance: 48230,
      transactions: [
        { id: 'TX-9931', date: '2026-11-06T16:20:00Z', counterparty: 'Marlow Design', amount: 4000, reference: 'INV-1029' },
        { id: 'TX-9712', date: '2026-10-12T09:45:00Z', counterparty: 'Delta Retail',  amount: 5600, reference: 'INV-1008' }
      ]
    },

    // Past actions and what happened next. Suggestions on the Priorities page are built from these rows,
    // so even the advice has a source. Keep samples honest: the UI always shows how many past cases back a suggestion.
    HISTORY: [
      { id: 'H1',  date: '2026-06-12', party: 'Brightwave Ltd',    ref: 'INV-0954', action: 'second_reminder',    outcome: 'worked',       days: 6,    note: 'Paid 6 days after a second reminder' },
      { id: 'H2',  date: '2026-08-04', party: 'Brightwave Ltd',    ref: 'INV-0981', action: 'second_reminder',    outcome: 'worked',       days: 5,    note: 'Paid 5 days after a second reminder' },
      { id: 'H3',  date: '2026-09-15', party: 'Brightwave Ltd',    ref: 'INV-0999', action: 'second_reminder',    outcome: 'did_not_work', days: null, note: 'No payment 14 days after a second reminder; paid after a phone call' },
      { id: 'H4',  date: '2026-08-20', party: 'Northgate Ltd',     ref: 'INV-0970', action: 'phone_call',         outcome: 'worked',       days: 2,    note: 'Paid 2 days after a call about a missed promise' },
      { id: 'H5',  date: '2026-07-09', party: 'Northgate Ltd',     ref: 'INV-0945', action: 'phone_call',         outcome: 'worked',       days: 3,    note: 'Paid 3 days after a call about a missed promise' },
      { id: 'H6',  date: '2026-05-14', party: 'Delta Retail',      ref: 'INV-0931', action: 'remittance_request', outcome: 'worked',       days: 2,    note: 'Payment located in the bank 2 days after asking for the remittance reference' },
      { id: 'H7',  date: '2026-07-22', party: 'Kestrel Foods',     ref: 'INV-0960', action: 'remittance_request', outcome: 'worked',       days: 1,    note: 'Payment located in the bank 1 day after asking for the remittance reference' },
      { id: 'H8',  date: '2026-09-02', party: 'Marlow Design',     ref: 'INV-0990', action: 'remittance_request', outcome: 'worked',       days: 3,    note: 'Payment located in the bank 3 days after asking for the remittance reference' },
      { id: 'H9',  date: '2026-03-18', party: 'Acme Ltd',          ref: 'INV-0902', action: 'remittance_request', outcome: 'did_not_work', days: null, note: 'No reference supplied; the payment arrived 6 days later anyway' },
      { id: 'H10', date: '2026-09-20', party: 'Stellar Packaging', ref: 'BILL-203', action: 'late_payment',       outcome: 'late_fee',     days: null, amount: 85, note: 'Charged a €85 late fee after a second notice went unpaid' },
      { id: 'H11', date: '2026-08-12', party: 'Marlow Design',     ref: 'INV-0977', action: 'balance_note',       outcome: 'worked',       days: 8,    note: 'Remaining balance paid 8 days after a short note' },
      { id: 'H12', date: '2026-06-30', party: 'Kestrel Foods',     ref: 'INV-0925', action: 'paid_on_time',       outcome: 'worked',       days: 0,    note: 'Paid on the due date' },
      { id: 'H13', date: '2026-08-31', party: 'Kestrel Foods',     ref: 'INV-0966', action: 'paid_on_time',       outcome: 'worked',       days: 0,    note: 'Paid on the due date' },
      { id: 'H14', date: '2026-10-05', party: 'Kestrel Foods',     ref: 'INV-1002', action: 'paid_on_time',       outcome: 'worked',       days: 0,    note: 'Paid on the due date' },
      { id: 'H15', date: '2026-09-17', party: 'Revenue (VAT)',     ref: 'VAT-JUL-AUG', action: 'filed',           outcome: 'early',        days: 2,    note: 'Return filed 2 days before the deadline' },
      { id: 'H16', date: '2026-07-17', party: 'Revenue (VAT)',     ref: 'VAT-MAY-JUN', action: 'filed',           outcome: 'early',        days: 1,    note: 'Return filed 1 day before the deadline' }
    ],

    // Monthly turnover from the P&L (EUR). Seasonality = each month's share of the year's turnover.
    PNL: {
      years: {
        2023: [31, 29, 33, 35, 36, 34, 30, 29, 37, 40, 46, 52].map((k) => k * 1000),
        2024: [34, 32, 36, 38, 40, 37, 33, 32, 41, 44, 50, 57].map((k) => k * 1000),
        2025: [37, 34, 40, 42, 43, 40, 36, 34, 44, 48, 55, 63].map((k) => k * 1000)
      },
      ytdYear: 2026,
      ytd: [40, 37, 43, 45, 47, 43, 38, 37, 48, 52].map((k) => k * 1000),
      costOfSalesPct: 0.52,
      overheadsMonthly: 20000
    },

    VAT_SHEET: { row: 3, title: 'VAT return, Sep–Oct', name: 'VAT', label: 'VAT payable Sep–Oct', ref: 'VAT-SEP-OCT', amount: 12480, due: '2026-11-19' },

    FORECAST: { row: 20, title: 'Cash forecast, Q4', label: 'Projected closing cash, 30 Nov', ref: 'FORECAST-Q4', amount: 61200 },

    EMAILS: [
      { id: 'E1', direction: 'received', from: 'ap@acme.ie', to: 'finance@harbourco.ie', date: '2026-11-04T14:02:00Z',
        subject: 'Remittance advice: INV-1042',
        body: "Hi Finance team,\n\nWe've released payment of €18,400 for INV-1042 today (4 Nov). Please allow 2–3 working days to arrive.\n\nRegards,\nAoife, Acme AP",
        extracted: [{ kind: 'payment_claim', ref: 'INV-1042', party: 'Acme Ltd', claim: 'paid', amount: 18400,
                      quote: "We've released payment of €18,400 for INV-1042 today (4 Nov)." }] },

      { id: 'E2', direction: 'sent', from: 'finance@harbourco.ie', to: 'accounts@brightwave.ie', date: '2026-10-31T10:15:00Z',
        subject: 'Reminder: INV-1017 is overdue',
        body: "Hi,\n\nA quick reminder that INV-1017 (€9,800) was due on 26 Oct and is still unpaid. Could you confirm when we can expect payment?\n\nThanks,\nFinance team",
        extracted: [{ kind: 'chase_sent', ref: 'INV-1017', party: 'Brightwave Ltd', claim: 'outstanding', amount: 9800,
                      quote: 'INV-1017 (€9,800) was due on 26 Oct and is still unpaid.' }] },

      { id: 'E3', direction: 'received', from: 'j.byrne@northgate.ie', to: 'finance@harbourco.ie', date: '2026-11-05T16:40:00Z',
        subject: 'Re: INV-1033',
        body: 'Hi,\n\nApologies for the delay on INV-1033. We will pay this on Friday.\n\nJohn Byrne, Northgate',
        extracted: [{ kind: 'promise_to_pay', ref: 'INV-1033', party: 'Northgate Ltd', claim: 'outstanding', promisedDate: '2026-11-07',
                      quote: 'We will pay this on Friday.' }] },

      { id: 'E4', direction: 'received', from: 'accounts@stellarpackaging.ie', to: 'finance@harbourco.ie', date: '2026-11-07T09:05:00Z',
        subject: 'Second notice: BILL-221 due 12 Nov',
        body: 'Dear customer,\n\nThis is a second notice that BILL-221 (€7,900) falls due on 12 Nov. Please arrange payment to avoid a late fee.\n\nStellar Packaging Accounts',
        extracted: [{ kind: 'supplier_notice', ref: 'BILL-221', party: 'Stellar Packaging', claim: 'outstanding', amount: 7900, dueDate: '2026-11-12',
                      quote: 'BILL-221 (€7,900) falls due on 12 Nov.' }] },

      { id: 'E5', direction: 'received', from: 'accountant@marshallco.ie', to: 'finance@harbourco.ie', date: '2026-11-06T12:30:00Z',
        subject: 'VAT3 draft: Sep/Oct',
        body: 'Hi,\n\nDraft VAT3 for Sep–Oct attached. VAT payable is €12,480, due 19 Nov via ROS.\n\nRegards,\nMarshall & Co',
        extracted: [{ kind: 'obligation', ref: 'VAT-SEP-OCT', party: 'Revenue (VAT)', claim: 'outstanding', amount: 12480, dueDate: '2026-11-19',
                      quote: 'VAT payable is €12,480, due 19 Nov via ROS.' }] },

      { id: 'E6', direction: 'received', from: 'sales@stellarpackaging.ie', to: 'finance@harbourco.ie', date: '2026-10-29T11:00:00Z',
        subject: 'Price update from 1 January',
        body: 'Hello,\n\nFrom 1 January we will be increasing our unit prices by approximately 8%. Full price list to follow.\n\nStellar Packaging Sales',
        extracted: [{ kind: 'info', ref: 'INFO-STELLAR-PRICE', party: 'Stellar Packaging', claim: 'price_increase', topic: 'a price rise of about 8% from 1 Jan', topicShort: 'price rise',
                      quote: 'we will be increasing our unit prices by approximately 8%.' }] },

      { id: 'E7', direction: 'received', from: 'ap@kestrelfoods.ie', to: 'finance@harbourco.ie', date: '2026-11-03T09:50:00Z',
        subject: 'PO 8821 confirmation',
        body: "Hi,\n\nThanks for the invoice. We'll pay INV-1055 on the due date, 20 Nov.\n\nKestrel Foods AP",
        extracted: [{ kind: 'promise_to_pay', ref: 'INV-1055', party: 'Kestrel Foods', claim: 'outstanding', promisedDate: '2026-11-20',
                      quote: "We'll pay INV-1055 on the due date, 20 Nov." }] },

      { id: 'E8', direction: 'received', from: 'accounts@marlowdesign.ie', to: 'finance@harbourco.ie', date: '2026-11-06T15:12:00Z',
        subject: 'Payment sent: INV-1029',
        body: "Hi,\n\nWe've sent €4,000 against INV-1029 today. The balance will follow next week.\n\nMarlow Design",
        extracted: [{ kind: 'payment_claim', ref: 'INV-1029', party: 'Marlow Design', claim: 'partial_paid', amount: 4000,
                      quote: "We've sent €4,000 against INV-1029 today." }] },

      { id: 'E9', direction: 'received', from: 'news@fintechweekly.com', to: 'finance@harbourco.ie', date: '2026-11-08T08:00:00Z',
        subject: 'Fintech weekly digest',
        body: 'Top stories this week: payment rails, open banking and a new funding round. Read more online.',
        extracted: [] }
    ]
  };
});
