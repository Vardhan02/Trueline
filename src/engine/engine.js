(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Engine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const MAX_EMAIL_ROWS = 5;
  const DAY = 864e5,
    AMBER_DAYS = 3;
  let STALE_DAYS = 7; // set per workspace in create(); one workspace per process
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const ms = (iso) => Date.parse(iso.length === 10 ? iso + 'T00:00:00Z' : iso);
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');

  // Display settings for the engine instance most recently created. One workspace per process, so this is safe.
  const fmt = { cur: '€', year: null };
  const SYMBOLS = { EUR: '€', GBP: '£', USD: '$' };

  function fd(iso, withTime) {
    const d = new Date(ms(iso));
    let s = d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()];
    if (fmt.year != null && d.getUTCFullYear() !== fmt.year) s += ' ' + d.getUTCFullYear();
    if (withTime) s += ', ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
    return s;
  }
  function eur(n) {
    const r = Math.round(n);
    return (r < 0 ? '-' : '') + fmt.cur + String(Math.abs(r)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  const DEFAULT_SOURCES = {
    ledger: { name: 'Accounting ledger', short: 'ledger' },
    tracker: { name: 'Payments tracker', short: 'payments tracker' },
    vat: { name: 'Tax workings', short: 'tax workings' },
    forecast: { name: 'Cash forecast', short: 'cash forecast' },
    bank: { name: 'Bank feed', short: 'bank' },
    pnl: { name: 'P&L workings', short: 'P&L' }
  };

  // Build the brief from a dataset. Only LEDGER and NOW are required: every other source is optional.
  function create(input) {
    const data = Object.assign({ LEDGER: [], TRACKER: [], EMAILS: [], HISTORY: [] }, input);
    ['LEDGER', 'TRACKER', 'EMAILS', 'HISTORY'].forEach((k) => {
      if (!Array.isArray(data[k])) data[k] = [];
    });
    STALE_DAYS = Number.isFinite(data.STALE_DAYS) && data.STALE_DAYS > 0 ? data.STALE_DAYS : 7;
    fmt.cur = SYMBOLS[data.CURRENCY] || '€';
    fmt.year = new Date(ms(data.NOW)).getUTCFullYear();
    data.LAST_BRIEF_AT = data.LAST_BRIEF_AT || new Date(ms(data.NOW) - 3 * DAY).toISOString();
    data.SOURCES = Object.assign({}, data.SOURCES);
    Object.keys(DEFAULT_SOURCES).forEach((k) => {
      data.SOURCES[k] = Object.assign({ id: k, file: '', syncedAt: data.NOW }, DEFAULT_SOURCES[k], data.SOURCES[k]);
    });
    const now = ms(data.NOW);
    const today = data.NOW.slice(0, 10);
    const dayDiff = (dateStr) => Math.round((ms(dateStr) - ms(today)) / DAY);
    const S = data.SOURCES;

    function ageOf(f) {
      const diff = now - ms(f.date);
      if (f.kind === 'history') {
        const dd = diff / DAY;
        return { days: dd, label: dd >= 60 ? Math.round(dd / 30) + ' mo' : Math.floor(dd) + ' d', cls: 'fresh' };
      }
      let label;
      if (diff < 3600e3) label = Math.max(1, Math.round(diff / 60e3)) + ' min';
      else if (diff < DAY) label = Math.round(diff / 3600e3) + ' h';
      else label = Math.floor(diff / DAY) + ' d';
      const days = diff / DAY;
      return { days, label, cls: days > STALE_DAYS ? 'old' : days > AMBER_DAYS ? 'amber' : 'fresh' };
    }

    // 1. Facts: one normalised record per claim, whatever the source. Every fact keeps its origin.
    function buildFacts() {
      const f = [];
      data.LEDGER.forEach((r) =>
        f.push({
          id: 'led_' + r.id,
          sourceId: 'ledger',
          sourceType: 'ledger',
          sourceName: S.ledger.name,
          short: S.ledger.short,
          origin: (r.file || S.ledger.file) + ' · row ' + r.row,
          date: S.ledger.syncedAt,
          ref: r.id,
          party: r.party,
          kind: 'ledger_entry',
          entryType: r.type,
          claim: r.status === 'open' ? 'outstanding' : 'paid',
          amount: r.amount,
          dueDate: r.due,
          snippet: r.id + ' · ' + r.party + ' · ' + eur(r.amount) + ' · due ' + fd(r.due) + ' · ' + r.status
        })
      );
      data.TRACKER.forEach((r) =>
        f.push({
          id: 'trk_' + r.row,
          sourceId: 'tracker',
          sourceType: 'sheet',
          sourceName: S.tracker.name,
          short: S.tracker.short,
          origin: S.tracker.file + ' · row ' + r.row,
          date: r.date,
          ref: r.ref,
          party: r.payer,
          kind: 'receipt',
          claim: 'paid',
          amount: r.amount,
          snippet: fd(r.date) + ' · ' + r.payer + ' · ' + r.ref + ' · ' + eur(r.amount) + ' received'
        })
      );
      const v = data.VAT_SHEET;
      if (v)
        f.push({
          id: 'vat_' + v.row,
          sourceId: 'vat',
          sourceType: 'sheet',
          sourceName: S.vat.name,
          short: S.vat.short,
          origin: S.vat.file + ' · row ' + v.row,
          date: S.vat.syncedAt,
          ref: v.ref,
          party: 'Revenue (VAT)',
          kind: 'obligation',
          claim: 'outstanding',
          amount: v.amount,
          dueDate: v.due,
          title: v.title || 'VAT return',
          obName: v.name || 'VAT',
          snippet: v.label + ' · ' + eur(v.amount) + ' · due ' + fd(v.due)
        });
      const c = data.FORECAST;
      if (c)
        f.push({
          id: 'fc_' + c.row,
          sourceId: 'forecast',
          sourceType: 'sheet',
          sourceName: S.forecast.name,
          short: S.forecast.short,
          origin: S.forecast.file + ' · row ' + c.row,
          date: S.forecast.syncedAt,
          ref: c.ref,
          party: 'Cash forecast',
          title: c.title || 'Cash forecast',
          kind: 'forecast',
          claim: 'projection',
          amount: c.amount,
          snippet: c.label + ' · ' + eur(c.amount)
        });
      if (data.BANK) {
        const B = data.BANK,
          bs = S.bank;
        const credited = (l) =>
          B.transactions.some((t) => t.reference === l.id || (t.counterparty.toLowerCase() === l.party.toLowerCase() && ms(t.date) >= ms(l.issued)));
        B.transactions.forEach((t) =>
          f.push({
            id: 'bnk_' + t.id,
            sourceId: 'bank',
            sourceType: 'bank',
            sourceName: bs.name,
            short: bs.short,
            origin: 'Bank feed · transaction ' + t.id,
            date: t.date,
            ref: t.reference,
            party: t.counterparty,
            kind: 'bank_credit',
            claim: 'paid',
            amount: t.amount,
            snippet: fd(t.date) + ' · ' + t.counterparty + ' · +' + eur(t.amount) + ' · ref ' + t.reference
          })
        );
        data.LEDGER.filter((l) => l.type === 'receivable' && l.status === 'open' && !credited(l)).forEach((l) =>
          f.push({
            id: 'bnkchk_' + l.id,
            sourceId: 'bank',
            sourceType: 'bank',
            sourceName: bs.name,
            short: bs.short,
            origin: 'Bank feed · checked ' + fd(bs.syncedAt, true),
            date: bs.syncedAt,
            ref: l.id,
            party: l.party,
            kind: 'bank_check',
            claim: 'no_credit',
            amount: null,
            snippet: 'No credit from ' + l.party + ' or with reference ' + l.id + ' since ' + fd(l.issued)
          })
        );
        if (typeof B.balance === 'number')
          f.push({
            id: 'bnk_balance',
            sourceId: 'bank',
            sourceType: 'bank',
            sourceName: bs.name,
            short: bs.short,
            origin: 'Bank feed · balance at ' + fd(bs.syncedAt, true),
            date: bs.syncedAt,
            ref: null,
            party: 'Bank',
            kind: 'bank_balance',
            claim: 'balance',
            amount: B.balance,
            snippet: 'Account balance · ' + eur(B.balance)
          });
      }
      (data.HISTORY || []).forEach((h) =>
        f.push({
          id: 'hist_' + h.id,
          sourceId: 'history',
          sourceType: 'history',
          sourceName: 'Action log',
          short: 'action log',
          origin: 'action_log.csv · ' + h.id,
          date: h.date + 'T09:00:00Z',
          ref: null,
          party: h.party,
          kind: 'history',
          action: h.action,
          claim: h.outcome,
          days: h.days == null ? null : h.days,
          amount: h.amount || null,
          snippet: h.note
        })
      );
      if (data.PNL) {
        const P = data.PNL,
          ps = S.pnl,
          tt = (v) => v.reduce((a, b) => a + b, 0),
          ytdArr = P.ytd || P.ytd2026 || [],
          ytdYear = String(P.ytdYear || fmt.year);
        const row = (v) =>
          MONTHS.slice(0, v.length)
            .map((m, i) => m + ' ' + eur(v[i]))
            .join(' · ') +
          ' · total ' +
          eur(tt(v));
        Object.keys(P.years).forEach((y) =>
          f.push({
            id: 'pnl_' + y,
            sourceId: 'pnl',
            sourceType: 'sheet',
            sourceName: ps.name,
            short: ps.short,
            origin: ps.file + ' · ' + y + ' tab',
            date: ps.syncedAt,
            ref: null,
            party: 'P&L',
            kind: 'pnl',
            claim: 'turnover',
            amount: tt(P.years[y]),
            snippet: row(P.years[y]),
            year: y
          })
        );
        if (ytdArr.length)
          f.push({
            id: 'pnl_ytd',
            sourceId: 'pnl',
            sourceType: 'sheet',
            sourceName: ps.name,
            short: ps.short,
            origin: ps.file + ' · ' + ytdYear + ' year to date',
            date: ps.syncedAt,
            ref: null,
            party: 'P&L',
            kind: 'pnl',
            claim: 'turnover',
            amount: tt(ytdArr),
            snippet: row(ytdArr),
            year: ytdYear,
            ytd: true
          });
        f.push({
          id: 'pnl_costs',
          sourceId: 'pnl',
          sourceType: 'sheet',
          sourceName: ps.name,
          short: ps.short,
          origin: ps.file + ' · costs tab',
          date: ps.syncedAt,
          ref: null,
          party: 'P&L',
          kind: 'pnl',
          claim: 'costs',
          amount: P.overheadsMonthly,
          snippet: 'Cost of sales ' + Math.round(P.costOfSalesPct * 100) + '% of turnover · overheads ' + eur(P.overheadsMonthly) + ' a month'
        });
      }
      data.EMAILS.forEach((e) =>
        (e.extracted || []).forEach((x, i) =>
          f.push({
            id: 'em_' + e.id + '_' + i,
            sourceId: 'inbox',
            sourceType: 'email',
            sourceName: 'Email',
            short: 'email',
            origin: (e.direction === 'sent' ? 'To ' + e.to : 'From ' + e.from) + ' · “' + e.subject + '”',
            date: e.date,
            ref: x.ref,
            party: x.party,
            kind: x.kind,
            claim: x.claim,
            amount: x.amount,
            topic: x.topic || null,
            topicShort: x.topicShort || null,
            dueDate: x.dueDate || null,
            promisedDate: x.promisedDate || null,
            snippet: x.quote,
            emailId: e.id
          })
        )
      );
      return f;
    }
    // One plain-English line per fact: what this source actually says. Shown next to every citation button.
    function summarize(f) {
      const a = f.amount != null ? eur(f.amount) : '';
      switch (f.kind) {
        case 'ledger_entry':
          return 'Ledger shows ' + f.ref + ' as ' + (f.claim === 'paid' ? 'paid' : 'open') + ', ' + a + ', due ' + fd(f.dueDate);
        case 'receipt':
          return 'Tracker records ' + a + ' received from ' + f.party + ' on ' + fd(f.date);
        case 'payment_claim':
          return f.party + ' says it ' + (f.claim === 'partial_paid' ? 'sent ' : 'paid ') + a;
        case 'chase_sent':
          return 'You sent ' + f.party + ' a reminder for ' + a;
        case 'promise_to_pay':
          return f.party + ' promised to pay on ' + fd(f.promisedDate);
        case 'supplier_notice':
          return f.party + ' sent a second notice: ' + a + ' due ' + fd(f.dueDate);
        case 'obligation':
          return (
            (f.sourceType === 'email' ? 'An email says' : cap(f.short) + ' show') +
            ' ' +
            (f.obName || 'the amount') +
            ' payable is ' +
            a +
            ', due ' +
            fd(f.dueDate)
          );
        case 'info':
          return f.party + ' mentions ' + (f.topic || 'something to check');
        case 'forecast':
          return 'Forecast projects closing cash of ' + a;
        case 'bank_credit':
          return 'Bank received ' + a + ' from ' + f.party + ' on ' + fd(f.date);
        case 'bank_check':
          return 'Bank feed shows no credit from ' + f.party;
        case 'bank_balance':
          return 'Bank balance is ' + a;
        case 'history':
          return f.party + ': ' + f.snippet;
        case 'pnl':
          return f.claim === 'costs' ? 'P&L costs: ' + f.snippet : f.year + ' P&L: ' + a + ' turnover' + (f.ytd ? ' so far' : '');
      }
      return f.snippet;
    }
    const facts = buildFacts();
    facts.forEach((f) => {
      f.summary = summarize(f);
    });
    const factById = {};
    facts.forEach((f) => (factById[f.id] = f));

    // 2. Reconcile: group by reference, compare sources, assign a trust state.
    function assessGroup(ref, fs) {
      const led = fs.find((f) => f.kind === 'ledger_entry');
      const others = fs.filter((f) => f !== led);
      const it = { ref, facts: fs, factIds: fs.map((f) => f.id), closed: false };
      const allOld = fs.every((f) => ageOf(f).days > STALE_DAYS);
      const first = fs[0];

      if (led) {
        Object.assign(it, { type: led.entryType, party: led.party, amount: led.amount, dueDate: led.dueDate, atStake: led.amount });
        if (led.claim === 'paid') {
          it.closed = true;
          it.trust = others.some((f) => f.claim === 'paid') ? 'agree' : 'record';
        } else {
          const paid = others.filter((f) => f.claim === 'paid' || f.claim === 'partial_paid');
          const bankCr = paid.filter((f) => f.kind === 'bank_credit');
          const hasCheck = others.some((f) => f.kind === 'bank_check');
          if (paid.length) {
            it.trust = 'conflict';
            it.paidFacts = paid;
            if (bankCr.length) {
              it.confirmed = true;
              it.paidAmount = Math.max.apply(
                null,
                bankCr.map((f) => f.amount)
              );
              it.partial = it.paidAmount < led.amount;
              it.atStake = it.partial ? led.amount - it.paidAmount : 0;
              it.badgeText = 'Bank confirms, ledger behind';
            } else {
              it.paidAmount = Math.max.apply(
                null,
                paid.map((f) => f.amount || 0)
              );
              it.partial = it.paidAmount < led.amount;
              if (hasCheck) {
                it.unreceived = true;
                it.atStake = led.amount;
                it.badgeText = 'Claimed paid, not in bank';
              } else it.atStake = it.partial ? led.amount - it.paidAmount : led.amount;
            }
          } else it.trust = others.length ? 'agree' : 'record';
        }
      } else if (first.kind === 'obligation') {
        const withAmt = fs.filter((f) => f.amount != null);
        Object.assign(it, { type: 'obligation', party: first.party, amount: first.amount, atStake: first.amount });
        it.dueDate = (fs.find((f) => f.dueDate) || {}).dueDate || null;
        const same = withAmt.every((f) => f.amount === withAmt[0].amount);
        it.trust = fs.length < 2 ? 'single' : same ? 'agree' : 'conflict';
        if (it.trust === 'conflict') {
          it.paidFacts = [];
          it.mismatch = true;
        }
      } else if (first.kind === 'forecast') {
        Object.assign(it, { type: 'forecast', party: first.party, amount: first.amount, atStake: first.amount, trust: 'record' });
      } else {
        Object.assign(it, { type: 'info', party: first.party, trust: 'single' });
      }
      if (it.trust !== 'conflict' && !it.closed && allOld) it.trust = 'stale';
      const RANK = { bank: 4, ledger: 3, sheet: 2, email: 1 };
      const best = fs.slice().sort((a, b) => RANK[b.sourceType] - RANK[a.sourceType])[0];
      it.strongest = best.sourceType === 'bank' ? 'bank feed' : best.sourceType === 'ledger' ? 'ledger' : best.sourceType === 'email' ? 'email' : best.short;
      it.daysTo = it.dueDate ? dayDiff(it.dueDate) : null;
      describe(it);
      score(it);
      return it;
    }

    function srcList(fs) {
      const parts = fs.map((f) => (f.sourceType === 'email' ? 'an email' : 'the ' + f.short) + ' (' + fd(f.date) + ')');
      return cap(parts.join(' and '));
    }
    function whenText(it) {
      const d = it.daysTo;
      if (d == null) return '';
      if (d < 0) return plural(-d, 'day') + ' overdue';
      if (d === 0) return 'due today';
      return 'due in ' + plural(d, 'day') + ' (' + fd(it.dueDate) + ')';
    }

    function describe(it) {
      const fs = it.facts;
      it.when = whenText(it);
      if (it.type === 'receivable' || it.type === 'payable') {
        it.title = it.party + ' · ' + it.ref;
        const chase = fs.find((f) => f.kind === 'chase_sent');
        const promise = fs.find((f) => f.kind === 'promise_to_pay' && f.promisedDate);
        const notice = fs.find((f) => f.kind === 'supplier_notice');
        if (it.trust === 'conflict') {
          const pf = it.paidFacts;
          const credit = pf.find((f) => f.kind === 'bank_credit');
          const claims = pf.filter((f) => f.kind !== 'bank_credit');
          if (it.confirmed) {
            it.reason = 'The bank received ' + eur(it.paidAmount) + ' on ' + fd(credit.date) + '. The ledger still shows ' + eur(it.amount) + ' open.';
            it.action = it.partial
              ? 'Allocate the ' + eur(it.paidAmount) + ' bank receipt in the ledger, then chase the ' + eur(it.atStake) + ' balance.'
              : 'Allocate the bank receipt to the invoice in the ledger. No chase needed.';
          } else if (it.unreceived) {
            const days = Math.floor((now - ms(claims[0].date)) / DAY);
            it.reason =
              srcList(claims) +
              ' report' +
              (claims.length > 1 ? '' : 's') +
              ' ' +
              eur(it.paidAmount) +
              ' paid, ' +
              plural(days, 'day') +
              ' ago. The bank shows no matching credit, and the ledger still shows it open.';
            it.action = 'Treat it as unpaid. Ask ' + it.party + ' for the remittance reference and check the bank again in 2 days.';
          } else {
            it.reason =
              srcList(pf) + ' report' + (pf.length > 1 ? '' : 's') + ' ' + eur(it.paidAmount) + ' paid. The ledger still shows ' + eur(it.amount) + ' open.';
            it.action = 'Check your bank account. If the money is there, update the ledger; if not, ask ' + it.party + ' for proof of payment.';
          }
        } else if (it.type === 'receivable') {
          let r = cap(it.when) + '.';
          let a = it.daysTo < 0 ? 'Send a reminder.' : 'No action needed yet.';
          const chk = fs.find((f) => f.kind === 'bank_check');
          let missed = false;
          if (chase) {
            r += ' You sent a reminder on ' + fd(chase.date) + '.';
            a = 'Send a second reminder.';
          }
          if (promise) {
            if (dayDiff(promise.promisedDate) < 0) {
              missed = true;
              r += ' They promised to pay on ' + fd(promise.promisedDate) + '; the bank shows nothing has arrived.';
              a = 'Chase the missed promise today.';
            } else r += ' They say they will pay on ' + fd(promise.promisedDate) + '.';
          }
          if (chk && it.daysTo < 0 && !missed) r += ' The bank shows no payment yet.';
          it.reason = r;
          it.action = a;
        } else {
          it.reason = cap(it.when) + '.' + (notice ? ' ' + it.party + ' sent a notice on ' + fd(notice.date) + '.' : ' Ledger is the only source.');
          it.action = it.daysTo <= 7 ? 'Schedule payment this week.' : 'Add to the next payment run.';
        }
      } else if (it.type === 'obligation') {
        it.title = (fs.find((f) => f.title) || {}).title || 'Tax return';
        it.reason =
          cap(it.when) +
          '. ' +
          (it.trust === 'agree'
            ? 'The ' + fs.map((f) => (f.sourceType === 'email' ? 'email' : f.short)).join(' and ') + ' both show ' + eur(it.amount) + '.'
            : it.trust === 'conflict'
              ? 'Your sources show different amounts.'
              : 'Only one source.');
        it.action = 'Review the draft and file it before the deadline.';
      } else if (it.type === 'info') {
        const f = fs[0];
        it.title = it.party + ': ' + (f.topicShort || 'a note') + ' mentioned';
        it.reason = 'One email from ' + fd(f.date) + ' (' + ageOf(f).label + ' old) is the only source for ' + (f.topic || 'this') + '.';
        it.action = 'Confirm with ' + it.party + ' before relying on it.';
      } else if (it.type === 'forecast') {
        const f = fs[0];
        it.title = f.title || 'Cash forecast';
        it.reason = 'Last edited ' + fd(f.date) + ', ' + ageOf(f).label + ' ago. Left out of the numbers until someone updates it.';
        it.action = 'Ask the owner of the sheet to refresh it.';
      }
    }

    function timeScore(d) {
      if (d == null) return 10;
      if (d < 0) return 50 + Math.min(30, -d * 2);
      if (d <= 3) return 70;
      if (d <= 7) return 55;
      if (d <= 14) return 40;
      return 15;
    }
    function score(it) {
      if (it.type === 'info' || it.type === 'forecast') {
        it.score = null;
        return;
      }
      const time = timeScore(it.daysTo);
      const size = Math.min(20, Math.log10(Math.max(it.atStake, 1)) * 4.5);
      const statutory = it.type === 'obligation' ? 10 : 0;
      let rel = { agree: 1, record: 1, conflict: 1, single: 0.6, stale: 0.4 }[it.trust];
      let bonus = it.trust === 'conflict' ? (it.partial ? 5 : 15) : 0;
      let note = '';
      if (it.confirmed) {
        rel = 0.5;
        bonus = 5;
        note = 'the bank already shows the money, so only bookkeeping is left';
      }
      it.score = Math.round(Math.min(100, (time + size + statutory) * rel + bonus));
      it.parts = { time: Math.round(time), size: Math.round(size), statutory, reliability: rel, bonus, note };
    }

    const groups = {};
    facts.forEach((f) => {
      if (f.ref) (groups[f.ref] = groups[f.ref] || []).push(f);
    });
    const items = Object.keys(groups).map((ref) => assessGroup(ref, groups[ref]));
    const byRef = {};
    items.forEach((i) => (byRef[i.ref] = i));

    // 3b. Suggestions: one short line plus a button, built from past cases in the action log.
    const contactFor = (party) => {
      const em = data.EMAILS.find((m) => (m.extracted || []).some((x) => x.party === party));
      return em ? (em.direction === 'sent' ? em.to : em.from) : '';
    };
    const shift = (dateStr, n) => new Date(ms(dateStr) + n * DAY).toISOString().slice(0, 10);
    function pastCases(action, party) {
      const all = facts.filter((f) => f.kind === 'history' && f.action === action);
      const own = all.filter((f) => f.party === party);
      const cases = own.length >= 2 ? own : all;
      const wins = cases.filter((f) => f.claim === 'worked' || f.claim === 'early').length;
      const days = cases
        .filter((f) => f.claim === 'worked' && f.days != null)
        .map((f) => f.days)
        .sort((a, b) => a - b);
      return {
        cases,
        n: cases.length,
        wins,
        own: cases.length > 0 && cases.every((f) => f.party === party),
        medianDays: days.length ? days[Math.floor((days.length - 1) / 2)] : null
      };
    }
    const ofN = (pc) => pc.wins + ' of ' + pc.n + ' past ' + (pc.n === 1 ? 'case' : pc.own ? 'cases with them' : 'cases across customers');
    const basisNote = (pc) => (pc.n === 0 ? ' No past cases yet.' : pc.n < 3 ? ' Small sample, so treat it as a hint.' : '');
    function suggest(it) {
      if (it.closed || !['receivable', 'payable', 'obligation'].includes(it.type)) return null;
      const P = it.party,
        fs = it.facts,
        to = contactFor(P);
      const amt = eur(it.amount),
        ref = it.ref;
      let pc = { cases: [], n: 0, wins: 0, own: false, medianDays: null },
        text = '',
        btn = null;
      const chase = fs.find((f) => f.kind === 'chase_sent');
      const promise = fs.find((f) => f.kind === 'promise_to_pay' && f.promisedDate);
      if (it.type === 'receivable' && it.unreceived) {
        pc = pastCases('remittance_request', P);
        text = 'Ask ' + P + ' for the remittance reference.' + (pc.n ? ' That located the payment in ' + ofN(pc) + '.' : '') + basisNote(pc);
        btn = {
          label: 'Draft request',
          kind: 'draft',
          title: 'Remittance request to ' + P,
          body:
            'To: ' +
            to +
            '\nSubject: Remittance reference for ' +
            ref +
            ' (' +
            amt +
            ')\n\nHi ' +
            P +
            ' team,\n\nThanks for letting us know payment for ' +
            ref +
            ' (' +
            amt +
            ') was released on ' +
            fd(it.paidFacts[0].date) +
            '. We can’t see it in our bank yet. Could you send the remittance reference or proof of payment so we can trace it?\n\nThanks,\nFinance team'
        };
      } else if (it.type === 'receivable' && it.confirmed) {
        const cr = it.paidFacts.find((f) => f.kind === 'bank_credit'),
          tx = cr.id.replace('bnk_', '');
        if (it.partial) {
          pc = pastCases('balance_note', P);
          text =
            'Allocate the ' +
            eur(it.paidAmount) +
            ' bank receipt in the ledger, then send a short balance note for ' +
            eur(it.atStake) +
            '.' +
            (pc.n && pc.medianDays != null ? ' A balance note got the rest paid in about ' + pc.medianDays + ' days last time.' : '') +
            basisNote(pc);
        } else text = 'Allocate the bank receipt to the invoice in the ledger. No chase needed.';
        btn = {
          label: 'Prepare ledger note',
          kind: 'note',
          title: 'Ledger allocation for ' + ref,
          body:
            'To: bookkeeper\nSubject: Please allocate bank receipt ' +
            tx +
            '\n\nPlease allocate bank receipt ' +
            tx +
            ' (' +
            eur(it.paidAmount) +
            ', ' +
            fd(cr.date) +
            ') to ' +
            ref +
            ' (' +
            P +
            ').' +
            (it.partial ? ' ' + eur(it.atStake) + ' remains open; we will send a short balance note.' : ' The invoice should then show as paid.')
        };
      } else if (it.type === 'receivable' && it.daysTo < 0 && promise && dayDiff(promise.promisedDate) < 0) {
        pc = pastCases('phone_call', P);
        text =
          'Call ' +
          P +
          ' today.' +
          (pc.n
            ? ' Calls after a missed promise got paid in ' + ofN(pc) + (pc.medianDays != null ? ', usually within ' + pc.medianDays + ' days' : '') + '.'
            : '') +
          basisNote(pc);
        btn = {
          label: 'Prepare call note',
          kind: 'note',
          title: 'Call note: ' + P,
          body:
            'Call note: ' +
            P +
            ', ' +
            ref +
            ' (' +
            amt +
            ')\n- They promised to pay on ' +
            fd(promise.promisedDate) +
            ' (email ' +
            fd(promise.date) +
            '). The bank shows nothing has arrived.\n- Ask for a firm payment date today, and the bank reference once it is sent.\n- Log the answer here and re-check the bank on that date.'
        };
      } else if (it.type === 'receivable' && it.daysTo < 0) {
        pc = pastCases('second_reminder', P);
        const second = !!chase;
        text = second
          ? 'Send a second reminder.' +
            (pc.n ? ' It worked in ' + ofN(pc) + (pc.medianDays != null ? ', usually paid in about ' + pc.medianDays + ' days' : '') + '.' : '') +
            basisNote(pc)
          : 'Send a first reminder.' + ' No past cases yet.';
        btn = {
          label: 'Draft reminder',
          kind: 'draft',
          title: (second ? 'Second reminder to ' : 'Reminder to ') + P,
          body:
            'To: ' +
            to +
            '\nSubject: ' +
            (second ? 'Second reminder: ' : 'Reminder: ') +
            ref +
            ' (' +
            amt +
            ') is ' +
            plural(-it.daysTo, 'day') +
            ' overdue\n\nHi ' +
            P +
            ' team,\n\n' +
            (second ? 'Following my note of ' + fd(chase.date) + ', ' : 'A quick follow-up: ') +
            ref +
            ' for ' +
            amt +
            ' was due on ' +
            fd(it.dueDate) +
            ' and is still unpaid. Could you confirm when payment will be made?\n\nThanks,\nFinance team'
        };
      } else if (it.type === 'receivable') {
        pc = pastCases('paid_on_time', P);
        text = 'No action needed.' + (pc.n ? ' ' + P + ' paid on time in ' + ofN(pc) + '.' : '') + basisNote(pc);
      } else if (it.type === 'payable') {
        pc = pastCases('late_payment', P);
        if (!pc.own) pc = { cases: [], n: 0, wins: 0, own: false, medianDays: null };
        const fee = pc.cases.find((f) => f.claim === 'late_fee');
        text =
          (it.daysTo <= 7 ? 'Pay by ' + fd(shift(it.dueDate, -1)) + '.' : 'Add to the next payment run.') +
          (fee && pc.own ? ' ' + P + ' charged ' + eur(fee.amount) + ' the last time a notice went unpaid.' : '') +
          basisNote(pc);
        btn = {
          label: 'Add to payment run',
          kind: 'task',
          title: 'Payment run: ' + P,
          body:
            'Payment run\n' +
            P +
            ' · ' +
            ref +
            ' · ' +
            amt +
            ' · pay by ' +
            fd(shift(it.dueDate, -1)) +
            '\nSource: ledger and supplier notice. Not paid. Approve and pay from your bank.'
        };
      } else if (it.type === 'obligation') {
        pc = pastCases('filed', P);
        const dd = pc.cases.map((f) => f.days);
        text =
          'Book the accountant review this week.' +
          (pc.n ? ' The last ' + pc.n + ' returns were filed ' + Math.min.apply(null, dd) + '–' + Math.max.apply(null, dd) + ' days early.' : '') +
          basisNote(pc);
        btn = {
          label: 'Draft note to accountant',
          kind: 'draft',
          title: 'Note to accountant',
          body:
            'To: ' +
            (contactFor('Revenue (VAT)') || 'accountant') +
            '\nSubject: ' +
            it.title +
            ': review before filing\n\nHi,\n\nThanks for the draft. Our own workings also show ' +
            amt +
            '. Could we review it on ' +
            fd(shift(today, 2)) +
            ' so it can be filed before ' +
            fd(it.dueDate) +
            '?\n\nThanks,\nFinance team'
        };
      }
      return { text, evidence: pc.cases.map((f) => f.id), n: pc.n, wins: pc.wins, button: btn };
    }
    items.forEach((i) => {
      i.suggestion = suggest(i);
    });

    const actionable = (i) => !i.closed && (i.type === 'receivable' || i.type === 'payable' || i.type === 'obligation');
    const ranked = items
      .filter((i) => actionable(i) && ['agree', 'record', 'conflict'].includes(i.trust))
      .sort((a, b) => b.score - a.score || b.amount - a.amount);
    const unverified = items.filter((i) => !i.closed && (i.trust === 'single' || i.trust === 'stale'));
    const buckets = [
      { key: 'today', label: 'Act today', items: ranked.filter((i) => i.score >= 75) },
      { key: 'watch', label: 'Keep an eye on', items: ranked.filter((i) => i.score >= 50 && i.score < 75) },
      { key: 'later', label: 'Later', items: ranked.filter((i) => i.score < 50) }
    ];

    // 3. MIS numbers: every figure carries the items behind it, so it can be drilled into.
    const ledgerIds = (list) => list.map((i) => 'led_' + i.ref);
    const sum = (list) => list.reduce((s, i) => s + i.amount, 0);
    const stake = (list) => list.reduce((s, i) => s + i.atStake, 0);
    const recv = items.filter((i) => i.type === 'receivable' && !i.closed);
    const overdue = recv.filter((i) => i.daysTo < 0);
    const payOut = items.filter((i) => i.type === 'payable' && !i.closed && i.daysTo <= 14);
    const verified = items.filter((i) => i.trust === 'agree' || i.trust === 'record');
    const bal = facts.find((f) => f.kind === 'bank_balance');
    const lag = recv.filter((i) => i.confirmed).reduce((s, i) => s + i.paidAmount, 0);
    const mis = {
      bank: bal ? { label: 'In the bank', value: bal.amount, date: bal.date, factIds: [bal.id] } : null,
      owed: { label: 'Owed to you', value: stake(recv), items: recv, factIds: ledgerIds(recv), lag, note: plural(recv.length, 'open invoice') },
      overdue: {
        label: 'Cash at risk',
        value: stake(overdue),
        items: overdue,
        factIds: ledgerIds(overdue),
        unreceived: stake(overdue.filter((i) => i.unreceived)),
        note: plural(overdue.length, 'invoice') + ' overdue'
      },
      payOut: { label: 'Due out, next 14 days', value: sum(payOut), items: payOut, factIds: ledgerIds(payOut), note: plural(payOut.length, 'bill') },
      health: { label: 'Data health', verified: verified.length, total: items.length, items },
      ageing: [
        { label: 'Not yet due', amount: stake(recv.filter((i) => i.daysTo >= 0)), items: recv.filter((i) => i.daysTo >= 0) },
        {
          label: '1–7 days late',
          amount: stake(recv.filter((i) => i.daysTo < 0 && i.daysTo >= -7)),
          items: recv.filter((i) => i.daysTo < 0 && i.daysTo >= -7)
        },
        { label: '8+ days late', amount: stake(recv.filter((i) => i.daysTo < -7)), items: recv.filter((i) => i.daysTo < -7) }
      ],
      forecastStale: items.some((i) => i.type === 'forecast' && i.trust === 'stale')
    };
    // 3c. Seasonality model: each month's share of annual turnover, averaged over the years in the P&L.
    const MN = MONTHS;
    const tot = (v) => v.reduce((a, b) => a + b, 0);
    const model = (() => {
      const P = data.PNL;
      if (!P || !P.years) return null;
      const years = Object.keys(P.years)
        .filter((y) => P.years[y].length === 12 && tot(P.years[y]) > 0)
        .sort();
      if (!years.length) return null;
      const shares = MN.map((_, m) => years.reduce((s, y) => s + P.years[y][m] / tot(P.years[y]), 0) / years.length);
      const cv = MN.map((_, m) => {
        const a = years.map((y) => P.years[y][m] / tot(P.years[y]));
        return Math.sqrt(a.reduce((s, x) => s + Math.pow(x - shares[m], 2), 0) / a.length) / shares[m];
      });
      const ytd = P.ytd || P.ytd2026 || [];
      const lastY = years[years.length - 1];
      const ytdShare = ytd.reduce((s, _, m) => s + shares[m], 0);
      const annual = ytd.length && ytdShare > 0 ? tot(ytd) / ytdShare : tot(P.years[lastY]);
      return { P, years, shares, cv, ytd, ytdYear: String(P.ytdYear || fmt.year), annual, growth: annual / tot(P.years[lastY]) - 1, lastY };
    })();
    const basisIds = model ? model.years.map((y) => 'pnl_' + y).concat(model.ytd.length ? ['pnl_ytd'] : [], ['pnl_costs']) : [];

    function forecast() {
      const bal = factById.bnk_balance;
      if (!model || !bal) return null;
      const { P, shares, cv, ytd, annual, growth } = model;
      const d0 = new Date(ms(data.NOW)),
        m0 = d0.getUTCMonth(),
        day = d0.getUTCDate();
      const dim = new Date(Date.UTC(d0.getUTCFullYear(), m0 + 1, 0)).getUTCDate();
      const f1 = 1 - (day - 1) / dim;
      const vatF = data.VAT_SHEET ? factById['vat_' + data.VAT_SHEET.row] : null,
        vatAmt = vatF ? vatF.amount : 0;
      // Turnover of the month `back` months before the current one: this year's year-to-date, else last year's column.
      const prevY = model.P.years[String(Number(model.ytdYear) - 1)] || model.P.years[model.lastY];
      const turn = (back) => {
        const idx = m0 - back;
        return idx >= 0 ? ytd[idx] : prevY[idx + 12];
      };
      if (turn(1) == null || turn(2) == null) return null;
      const atRisk = mis.overdue.value;
      // One or two years cannot show how much a month really swings; a back-test on real data missed a ±8% band in 6 of 8 months.
      const thinHistoryFloor = model.years.length < 2 ? 0.25 : model.years.length < 3 ? 0.18 : 0;
      const SC = ['low', 'base', 'high'];
      const closing = { low: bal.amount, base: bal.amount, high: bal.amount };
      const out = [];
      for (let i = 0; i < 3; i++) {
        const mi = (m0 + i) % 12,
          k = Math.max(0.08 + cv[mi], thinHistoryFloor),
          an = m0 + i >= 12 ? annual * (1 + growth) : annual;
        const b = an * shares[mi];
        const T = { low: b * (1 - k), base: b, high: b * (1 + k) };
        const row = { label: MN[mi], span: i === 0 ? MN[mi] + ' ' + day + '–' + dim : MN[mi], k, turnover: T, receipts: {}, payments: {}, closing: {} };
        SC.forEach((s) => {
          const prev = i === 0 ? turn(1) : out[i - 1].turnover[s];
          let rec = prev * (i === 0 ? f1 : 1);
          if (s === 'low' && i === 0) rec -= atRisk;
          if (s === 'low' && i === 1) rec += atRisk;
          let pay = (P.costOfSalesPct * b + P.overheadsMonthly) * (i === 0 ? f1 : 1);
          if (i === 0) pay += vatAmt;
          if (i === 2 && vatAmt) pay += vatAmt * ((out[0].turnover.base + out[1].turnover.base) / (turn(2) + turn(1)));
          closing[s] = closing[s] + rec - pay;
          row.receipts[s] = rec;
          row.payments[s] = pay;
          row.closing[s] = closing[s];
        });
        out.push(row);
      }
      const years = model.years.length;
      const spread = Math.max.apply(
        null,
        out.map((r) => r.k)
      );
      return {
        opening: bal.amount,
        months: out,
        annual,
        growth,
        atRisk,
        vat: vatAmt,
        minLow: Math.min.apply(
          null,
          out.map((r) => r.closing.low)
        ),
        confidence: years >= 3 && spread <= 0.12 ? 'Medium' : 'Low',
        confidenceWhy:
          years +
          (years === 1 ? ' year' : ' years') +
          ' of P&L, ' +
          model.ytdYear +
          ' is tracking ' +
          (growth >= 0 ? '+' : '') +
          Math.round(growth * 100) +
          '% against ' +
          model.lastY,
        assumptions: [
          'Customers pay about a month after the sale, so each month’s receipts are the month before’s sales.',
          'Costs are ' + Math.round(P.costOfSalesPct * 100) + '% of sales plus ' + eur(P.overheadsMonthly) + ' a month of overheads.',
          vatAmt
            ? 'Tax of ' + eur(vatAmt) + ' leaves on ' + fd(vatF.dueDate) + '; the next bill is estimated from sales.'
            : 'No tax bill is included because no tax workings are connected.',
          'Low case: sales ' + Math.round(out[0].k * 100) + '% below the seasonal pattern, and the ' + eur(atRisk) + ' of cash at risk arrives a month late.',
          'High case: sales ' + Math.round(out[0].k * 100) + '% above the seasonal pattern.'
        ],
        basisIds: basisIds.concat([bal.id], vatF ? [vatF.id] : [])
      };
    }
    function budget(g) {
      if (!model) return null;
      const gr = g == null ? model.growth : g;
      const an = model.annual * (1 + gr);
      return {
        growth: gr,
        annual: an,
        prior: model.annual,
        months: MN.map((m, i) => ({ label: m, share: model.shares[i], amount: an * model.shares[i], prior: model.annual * model.shares[i] })),
        peak: MN[model.shares.indexOf(Math.max.apply(null, model.shares))],
        basisIds: basisIds.slice(0, model.years.length + 1)
      };
    }
    const fc = forecast();

    // 3d. The morning brief as a plain email: how a non-technical owner receives it without opening anything.
    function briefEmail() {
      const actionOf = (i) => (i.suggestion ? i.suggestion.text : i.action).split(/(?<=\.)\s/)[0].replace(/\.$/, '');
      const needsAction = buckets[0].items.filter((i) => !/^no action/i.test(actionOf(i)));
      const pool = needsAction.length ? needsAction : ranked.slice(0, 3);
      const top = pool.slice(0, MAX_EMAIL_ROWS); // a morning email is a glance, not a list
      const rows = top.map((i) => ({
        title: i.title.replace(/ · .*/, ''),
        ref: i.ref,
        amount: i.amount,
        flag: i.trust === 'conflict',
        note: i.badgeText || i.when,
        action: actionOf(i)
      }));
      const cash = { bank: mis.bank ? mis.bank.value : null, risk: mis.overdue.value, unreceived: mis.overdue.unreceived || 0 };
      const L = ['DO TODAY'];
      rows.forEach((r, n) => L.push(n + 1 + '. ' + r.title + ', ' + eur(r.amount) + ': ' + r.note, '   → ' + r.action));
      if (pool.length > top.length) L.push('', '+' + (pool.length - top.length) + ' more in the app.');
      L.push('', 'CASH', (cash.bank != null ? 'In the bank ' + eur(cash.bank) + ' · ' : '') + 'At risk ' + eur(cash.risk));
      if (unverified.length) L.push('', 'COULDN’T VERIFY', plural(unverified.length, 'item') + ' held back until a second source confirms.');
      L.push('', 'Every line links to its source in the app.');
      return {
        subject: plural(pool.length, 'thing') + ' need' + (pool.length === 1 ? 's' : '') + ' you today',
        from: data.BRIEF_FROM || 'Trueline',
        to: data.BRIEF_TO || '',
        rows,
        cash,
        unverified: unverified.length,
        body: L.join('\n')
      };
    }

    const changes = facts
      .filter((f) => !['ledger_entry', 'bank_check', 'bank_balance'].includes(f.kind) && ms(f.date) > ms(data.LAST_BRIEF_AT))
      .sort((a, b) => ms(b.date) - ms(a.date));

    // 4. Citations: an answer is a list of claims, each citing record ids. We check them before showing anything.
    function validateAnswer(ans, allowed) {
      const claims = (Array.isArray(ans.claims) ? ans.claims : []).map((c) => {
        const issues = [];
        const ids = Array.isArray(c.record_ids) ? c.record_ids : [];
        if (!ids.length) issues.push('no source cited');
        ids.forEach((id) => {
          if (!factById[id]) issues.push('unknown record ' + id);
          else if (allowed && !allowed.has(id)) issues.push('record ' + id + ' was not retrieved');
        });
        if (!issues.length) {
          const cited = ids.map((id) => factById[id]);
          const amounts = new Set(cited.filter((f) => f.amount != null).map((f) => f.amount));
          amounts.add(cited.filter((f) => f.kind === 'ledger_entry').reduce((s, f) => s + f.amount, 0));
          const gaps = new Set();
          cited.forEach((f) => {
            if (f.kind === 'ledger_entry')
              cited.forEach((g) => {
                if (g !== f && g.amount != null && g.amount < f.amount && g.kind !== 'ledger_entry') gaps.add(f.amount - g.amount);
              });
          });
          gaps.forEach((g) => amounts.add(g));
          (c.derived || []).forEach((n) => amounts.add(n));
          const found = String(c.text).match(/-?[€£$]\s?[\d,]+/g) || [];
          found.forEach((m) => {
            const n = parseInt(m.replace(/[^\d]/g, ''), 10) * (m.charAt(0) === '-' ? -1 : 1);
            if (!amounts.has(n) && !amounts.has(Math.abs(n))) issues.push(m + ' does not match the cited records');
          });
        }
        return { text: c.text, record_ids: ids, valid: issues.length === 0, issues };
      });
      return Object.assign({}, ans, { claims });
    }

    // 5. Ask: retrieve records for a question, then compose cited claims.
    // Customer and supplier names the question can mention: the full name, or its first word when that word is unique.
    const NAMES = (() => {
      const byParty = {};
      items
        .filter((i) => i.type === 'receivable' || i.type === 'payable')
        .forEach((i) => {
          (byParty[i.party.toLowerCase()] = byParty[i.party.toLowerCase()] || []).push(i.ref);
        });
      const first = {};
      Object.keys(byParty).forEach((p) => {
        const w = p.split(/\s+/)[0];
        first[w] = (first[w] || []).concat(w === p ? [] : [p]);
      });
      const out = [];
      Object.keys(byParty).forEach((p) => {
        // Most recent ledger entry for that party stands in for it.
        out.push([p, byParty[p][0]]);
        const w = p.split(/\s+/)[0];
        if (w !== p && w.length >= 4 && first[w].length === 1) out.push([w, byParty[p][0]]);
      });
      return out;
    })();
    function retrieve(q) {
      const s = q.toLowerCase();
      let intent = 'none',
        list = [];
      const refs = new Set();
      (q.match(/(inv|bill)[- ]?\d+/gi) || []).forEach((m) => refs.add(m.toUpperCase().replace(/[- ]?(\d)/, '-$1')));
      NAMES.forEach((n) => {
        if (s.includes(n[0])) refs.add(n[1]);
      });
      if (/\bvat\b|\btax\b|\bros\b/.test(s)) items.filter((i) => i.type === 'obligation').forEach((i) => refs.add(i.ref));
      if (refs.size) {
        intent = 'entity';
        list = [...refs].map((r) => byRef[r]).filter(Boolean);
      } else if (/forecast|budget|outlook|season|runway|90 days|ninety|next (three|3) months|end of (nov|dec|jan)/.test(s)) {
        intent = 'forecast';
        list = [];
      } else if (/\bbank\b|balance|cash in/.test(s)) {
        intent = 'bank';
        list = [];
      } else if (/risk|exposure|worried|worry/.test(s)) {
        intent = 'risk';
        list = overdue;
      } else if (/conflict|disagree|mismatch|wrong/.test(s)) {
        intent = 'conflicts';
        list = items.filter((i) => i.trust === 'conflict');
      } else if (/overdue|late|owes? me|who owes|owed/.test(s)) {
        intent = 'overdue';
        list = overdue;
      } else if (/chang|\bnew\b|since|happened/.test(s)) {
        intent = 'changes';
      } else if (/verify|trust|stale|unconfirmed|reliab|sure|confiden|health/.test(s)) {
        intent = 'unverified';
        list = unverified;
      } else if (/bill|supplier|payable|we owe|pay out/.test(s)) {
        intent = 'payables';
        list = items.filter((i) => i.type === 'payable' && !i.closed);
      } else if (/priorit|first|urgent|today|top|focus/.test(s)) {
        intent = 'top';
        list = ranked.slice(0, 3);
      }
      const bal2 = facts.find((f) => f.kind === 'bank_balance');
      const fx =
        intent === 'changes'
          ? changes
          : intent === 'forecast'
            ? fc
              ? fc.basisIds.map((id) => factById[id])
              : []
            : intent === 'bank'
              ? bal2
                ? [bal2]
                : []
              : [].concat.apply(
                  [],
                  list.map((i) => i.facts.concat((i.suggestion ? i.suggestion.evidence : []).map((id) => factById[id])))
                );
      return { intent, items: list, facts: fx, question: q };
    }
    function itemClaim(i) {
      const amt = i.amount != null && i.type !== 'info' && i.type !== 'forecast' ? ', ' + eur(i.amount) : '';
      const sg = i.suggestion
        ? ' Suggested: ' + i.suggestion.text
        : i.action && i.trust !== 'stale' && i.trust !== 'single'
          ? ' Suggested next step: ' + i.action
          : '';
      return { text: i.title + amt + '. ' + i.reason + sg, record_ids: i.factIds.concat(i.suggestion ? i.suggestion.evidence : []) };
    }
    function composeLocal(r) {
      const claims = [],
        notes = [];
      let draft = null;
      if (r.intent === 'none')
        notes.push(
          'I can’t answer that from the records I have. I can cover invoices, bills, the VAT return, conflicts between sources, and what changed since the last brief.'
        );
      else if (r.intent === 'changes') {
        r.facts.forEach((f) => claims.push({ text: cap(f.short) + ' (' + fd(f.date) + '): ' + f.snippet, record_ids: [f.id] }));
        if (!r.facts.length) notes.push('Nothing new since the last brief.');
      } else if (r.intent === 'forecast') {
        if (!fc) notes.push('No P&L is connected, so I can’t forecast.');
        else {
          const last = fc.months[2],
            R = Math.round,
            bd = budget();
          claims.push({
            text:
              'Base case: the bank balance goes from ' +
              eur(fc.opening) +
              ' to ' +
              eur(last.closing.base) +
              ' by the end of ' +
              last.label +
              '. The weakest point in the low case is ' +
              eur(fc.minLow) +
              '.',
            record_ids: fc.basisIds,
            derived: [R(fc.opening), R(last.closing.base), R(fc.minLow)]
          });
          claims.push({
            text:
              'The budget for next year at ' +
              Math.round(bd.growth * 100) +
              '% growth is ' +
              eur(bd.annual) +
              ', with ' +
              bd.peak +
              ' the busiest month at ' +
              Math.round(
                Math.max.apply(
                  null,
                  bd.months.map((m) => m.share)
                ) * 100
              ) +
              '% of the year.',
            record_ids: bd.basisIds,
            derived: [R(bd.annual)]
          });
          notes.push('Confidence: ' + fc.confidence.toLowerCase() + ' (' + fc.confidenceWhy + '). This is a pattern from past turnover, not a promise.');
        }
      } else if (r.intent === 'bank') {
        r.facts.forEach((f) => claims.push({ text: 'The bank feed shows ' + eur(f.amount) + ' as of ' + fd(f.date, true) + '.', record_ids: [f.id] }));
        if (!r.facts.length) notes.push('No bank feed is connected.');
      } else if (r.items.length) {
        if (r.intent === 'overdue') {
          claims.push({
            text: plural(r.items.length, 'invoice') + ' are overdue, totalling ' + eur(sum(r.items)) + ' in the ledger.',
            record_ids: ledgerIds(r.items)
          });
        }
        r.items.forEach((i) => claims.push(itemClaim(i)));
        if (/draft|chase|reminder|email/i.test(r.question)) {
          const t = r.items.find((i) => i.type === 'receivable' && !i.closed && i.daysTo < 0 && i.trust !== 'conflict');
          if (t)
            draft =
              'Subject: Reminder: ' +
              t.ref +
              ' (' +
              eur(t.amount) +
              ') is overdue\n\nHi ' +
              t.party +
              ' team,\n\nA quick follow-up on ' +
              t.ref +
              ' for ' +
              eur(t.amount) +
              ', which was due on ' +
              fd(t.dueDate) +
              ' and is now ' +
              plural(-t.daysTo, 'day') +
              ' overdue. Could you confirm when payment will be made?\n\nThanks,\nFinance team';
          else notes.push('I can’t draft a chase while the sources disagree about whether it has been paid. Resolve that first.');
        }
      } else notes.push('Nothing in the records matches that.');
      return { claims, notes, draft };
    }
    function coverage() {
      const names = Object.keys(S)
        .filter(
          (k) =>
            data[{ ledger: 'LEDGER', bank: 'BANK', pnl: 'PNL', vat: 'VAT_SHEET', forecast: 'FORECAST', tracker: 'TRACKER' }[k]] &&
            ((k !== 'ledger' && k !== 'tracker') || data[k === 'ledger' ? 'LEDGER' : 'TRACKER'].length)
        )
        .map((k) => S[k].short);
      if ((data.EMAILS || []).length) names.push('email');
      if ((data.HISTORY || []).length) names.push('action log');
      if (!names.length) return 'No sources connected yet. Last sync ' + fd(data.NOW, true) + '.';
      return 'Based on ' + plural(names.length, 'source') + ' (' + names.join(', ') + '). Last sync ' + fd(data.NOW, true) + '.';
    }
    function askLocal(q) {
      const r = retrieve(q);
      const a = validateAnswer(composeLocal(r), new Set(r.facts.map((f) => f.id)));
      a.coverage = coverage();
      a.intent = r.intent;
      return a;
    }

    return {
      data,
      now,
      facts,
      factById,
      items,
      byRef,
      ranked,
      buckets,
      unverified,
      mis,
      changes,
      ageOf,
      forecast: fc,
      budget,
      briefEmail,
      model,
      retrieve,
      validateAnswer,
      askLocal,
      composeLocal,
      coverage,
      constants: { STALE_DAYS, AMBER_DAYS }
    };
  }

  return { create, fd, eur, cap, plural };
});
