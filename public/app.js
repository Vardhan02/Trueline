'use strict';
(function () {
  const STATIC = window.TRUELINE_STATIC || null; // set by the hosted read-only demo build
  const PAGE = 12; // priority cards shown per group before "show more"
  const shown = {};
  const E = Engine,
    fd = E.fd,
    eur = E.eur,
    cap = E.cap,
    plural = E.plural;
  let eng = null,
    ws = null,
    session = { authed: Boolean(STATIC), user: null, signup: { open: true, codeRequired: false } },
    acct = null,
    authMode = 'signin',
    revealed = null,
    busy = null,
    pending = [];
  const prepared = [],
    thread = [];
  let bgrowth = null,
    view = (location.hash || '#overview').slice(1),
    filter = 'all';
  const $ = (s) => document.querySelector(s);
  let prefs = { theme: null, zoom: 1, contrast: false, motion: false };
  try {
    Object.assign(prefs, JSON.parse(localStorage.getItem('trueline.prefs') || '{}'));
  } catch (e) {
    /* storage unavailable: preferences just are not saved */
  }
  function applyPrefs(save) {
    const dark = (prefs.theme || (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')) === 'dark';
    const r = document.documentElement;
    r.dataset.theme = dark ? 'dark' : 'light';
    r.style.zoom = prefs.zoom === 1 ? '' : prefs.zoom;
    if (prefs.contrast) r.dataset.contrast = 'high';
    else delete r.dataset.contrast;
    if (prefs.motion) r.dataset.motion = 'reduce';
    else delete r.dataset.motion;
    const tb = $('#b-theme');
    if (tb) {
      tb.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
    }
    document.querySelectorAll('[data-zoom]').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.zoom === prefs.zoom)));
    const c = $('#t-contrast'),
      m = $('#t-motion');
    if (c) c.checked = prefs.contrast;
    if (m) m.checked = prefs.motion;
    if (save) {
      try {
        localStorage.setItem('trueline.prefs', JSON.stringify(prefs));
      } catch (e) {
        /* storage unavailable: preferences just are not saved */
      }
    }
  }
  function togglePop(open) {
    const pop = $('#pop'),
      b = $('#b-zoom'),
      on = open == null ? pop.hidden : open;
    pop.hidden = !on;
    b.setAttribute('aria-expanded', String(on));
    if (on) {
      const f = pop.querySelector('button');
      if (f) f.focus();
    } else b.focus();
  }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const ICON = {
    email:
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1.5" y="3" width="13" height="10" rx="2"/><path d="m2 4.5 6 4.5 6-4.5"/></svg>',
    sheet:
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1.5" y="2" width="13" height="12" rx="2"/><path d="M1.5 6h13M6 6v8"/></svg>',
    bank: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1.5 6 8 2l6.5 4M3 6.5v5M6 6.5v5M10 6.5v5M13 6.5v5M1.5 13.5h13"/></svg>',
    history:
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2.5 8a5.5 5.5 0 1 0 1.7-4M2 2.5v3h3M8 5v3.2l2 1.3"/></svg>',
    ledger:
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><ellipse cx="8" cy="4" rx="6" ry="2.5"/><path d="M2 4v8c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5V4M2 8c0 1.4 2.7 2.5 6 2.5S14 9.4 14 8"/></svg>'
  };

  /* shared pieces */
  const srcName = (f) =>
    f.sourceType === 'email'
      ? 'Email'
      : f.sourceType === 'ledger'
        ? 'Ledger'
        : f.sourceType === 'bank'
          ? 'Bank feed'
          : f.sourceType === 'history'
            ? 'Action log'
            : cap(f.short);
  const cite = (id) => {
    const f = eng.factById[id];
    if (!f) return '';
    const a = eng.ageOf(f);
    return (
      '<div class="cite ' +
      a.cls +
      '"><span class="ico">' +
      ICON[f.sourceType] +
      '</span><div class="ct"><b>' +
      esc(f.summary) +
      '</b><small>' +
      srcName(f) +
      ' · ' +
      fd(f.date) +
      ' · <span class="age">' +
      a.label +
      ' old</span></small></div>' +
      '<button class="viewsrc" data-fact="' +
      esc(id) +
      '" aria-label="View source: ' +
      esc(f.summary) +
      '">View source <span aria-hidden="true">↗</span></button></div>'
    );
  };
  const chips = (ids, label) => (label ? '<div class="srclabel">' + label + '</div>' : '') + '<div class="cites">' + ids.map(cite).join('') + '</div>';
  const badge = (it, lean) => {
    const n = it.facts.length;
    const t =
      it.badgeText ||
      { agree: n + ' sources agree', record: 'Ledger only', conflict: 'Sources conflict', single: 'Unconfirmed, 1 source', stale: 'Stale data' }[it.trust];
    return (
      '<span class="badge ' +
      (it.confirmed ? 'single' : it.trust) +
      '">' +
      t +
      '</span>' +
      (!lean && it.strongest && it.type !== 'info' ? ' <span class="strong">Strongest evidence: ' + esc(it.strongest) + '</span>' : '')
    );
  };

  /* pages */
  function overview() {
    const m = eng.mis,
      top = eng.ranked.slice(0, 3),
      act = eng.buckets[0].items.length,
      plural = E.plural;
    const tile = (key, big, sub, warn, ok) =>
      '<button class="kpi" data-metric="' +
      key +
      '"><small>' +
      m[key].label +
      '</small><b>' +
      big +
      '</b><em' +
      (warn ? '' : ' class="ok"') +
      '>' +
      (warn || ok) +
      '</em></button>';
    const maxA = Math.max.apply(null, m.ageing.map((a) => a.amount).concat(1));
    const cls = ['', 'late', 'later'];
    return (
      '<h1>' +
      (act ? plural(act, 'thing') + ' need' + (act === 1 ? 's' : '') + ' you today' : 'Nothing urgent today') +
      '</h1><p class="sub">' +
      (m.overdue.unreceived ? eur(m.overdue.unreceived) + ' was claimed paid but is not in the bank. ' : '') +
      esc(eng.data.COMPANY) +
      ' · ' +
      fd(eng.data.NOW) +
      '</p>' +
      '<div class="kpis">' +
      (m.bank ? tile('bank', eur(m.bank.value), 'Live bank feed', '', 'Synced ' + fd(m.bank.date, true).split(', ')[1]) : '') +
      tile('owed', eur(m.owed.value), m.owed.note, m.owed.lag ? eur(m.owed.lag) + ' in the bank, not in the ledger yet' : '', 'All sources agree') +
      tile(
        'overdue',
        eur(m.overdue.value),
        m.overdue.note,
        m.overdue.unreceived ? eur(m.overdue.unreceived) + ' claimed paid, not in the bank' : '',
        'Nothing unconfirmed'
      ) +
      tile('payOut', eur(m.payOut.value), m.payOut.note, '', 'Supplier notice on file') +
      '<button class="kpi" data-metric="health"><small>Data health</small><b>' +
      m.health.verified +
      ' of ' +
      m.health.total +
      '</b><em' +
      (m.health.verified === m.health.total ? ' class="ok">Everything checks out' : '>' + (m.health.total - m.health.verified) + ' need attention') +
      '</em></button>' +
      '</div>' +
      '<div class="two"><div><h2>Who owes you, by lateness</h2><div class="card">' +
      m.ageing
        .map(
          (a, i) =>
            '<button class="age-row ' +
            cls[i] +
            '" data-age="' +
            i +
            '"><span>' +
            a.label +
            '</span><span class="track"><i style="width:' +
            Math.round((a.amount / maxA) * 100) +
            '%"></i></span><span>' +
            eur(a.amount) +
            '</span></button>'
        )
        .join('') +
      '</div></div><div><h2>Needs you most</h2><div class="card">' +
      (top.length
        ? top
            .map(
              (i, n) =>
                '<button class="mini" data-item="' +
                i.ref +
                '"><span class="n">' +
                (n + 1) +
                '</span><span><b>' +
                esc(i.title) +
                '</b><small>' +
                esc(i.when) +
                ' · ' +
                esc(i.badgeText ? i.badgeText.toLowerCase() : i.trust === 'conflict' ? 'sources conflict' : 'verified') +
                '</small></span><span class="amt">' +
                eur(i.amount) +
                '</span></button>'
            )
            .join('')
        : '<div class="empty">Nothing urgent.</div>') +
      '<div style="padding-top:8px"><button class="link" data-go="priorities">See all priorities →</button></div></div></div></div>' +
      outlook() +
      '<div style="margin-top:20px"><button class="link" data-changes="1">' +
      plural(eng.changes.length, 'change') +
      ' since your last brief →</button></div>'
    );
  }

  const KIND = { draft: 'Draft email', note: 'Note', task: 'Task' };
  function suggestion(it, short) {
    const s = it.suggestion;
    if (!s) return '<span class="sugg-line"><b>' + esc(it.action) + '</b></span>';
    const done = s.button && prepared.some((x) => x.ref === it.ref);
    return (
      '<span class="sugg-line"><b>' +
      esc(short || s.text) +
      '</b><span class="basis">' +
      (s.n
        ? '<button class="link" data-hist="' +
          it.ref +
          '">' +
          (s.wins > 0 ? 'Worked in ' + s.wins + ' of ' + s.n : 'Based on ' + s.n) +
          ' past ' +
          (s.n === 1 ? 'case' : 'cases') +
          '</button>'
        : 'No past cases yet') +
      '</span></span>' +
      (s.button
        ? '<button class="btn sm' + (done ? ' done' : '') + '" data-prep="' + it.ref + '">' + (done ? 'Prepared ✓' : esc(s.button.label)) + '</button>'
        : '')
    );
  }
  function outlook() {
    const f = eng.forecast;
    if (!f) return '';
    const hi = Math.max.apply(null, f.months.map((m) => m.closing.high).concat(f.opening)),
      lo = Math.min(0, f.minLow),
      span = hi - lo || 1;
    const pc = (v) => (((v - lo) / span) * 100).toFixed(1) + '%';
    const worst = f.months.reduce((a, m) => (m.closing.low < a.closing.low ? m : a), f.months[0]);
    const warn = f.minLow < f.opening * 0.25;
    return (
      '<h2>Outlook</h2><div class="card" id="fc-card"><div class="fc-head"><div><b>Cash, next 90 days</b></div>' +
      '<span class="pill2' +
      (f.confidence === 'Low' ? ' warn' : '') +
      '" title="' +
      esc(f.confidenceWhy) +
      '">' +
      f.confidence +
      ' confidence</span></div>' +
      '<div class="fc-row"><span class="fc-m">Today</span> <span class="fc-track" aria-hidden="true">' +
      (lo < 0 ? '<i class="zero" style="left:' + pc(0) + '"></i>' : '') +
      '<i class="base" style="left:' +
      pc(f.opening) +
      '"></i></span><span class="fc-v">' +
      eur(f.opening) +
      '<small>bank feed</small></span></div>' +
      f.months
        .map(
          (m) =>
            '<div class="fc-row"><span class="fc-m">End of ' +
            m.label +
            '</span> <span class="fc-track" aria-hidden="true">' +
            (lo < 0 ? '<i class="zero" style="left:' + pc(0) + '"></i>' : '') +
            '<i class="rng" style="left:' +
            pc(m.closing.low) +
            ';width:' +
            (((m.closing.high - m.closing.low) / span) * 100).toFixed(1) +
            '%"></i><i class="base" style="left:' +
            pc(m.closing.base) +
            '"></i></span><span class="fc-v">' +
            eur(m.closing.base) +
            '<small>' +
            eur(m.closing.low) +
            ' to ' +
            eur(m.closing.high) +
            '</small></span></div>'
        )
        .join('') +
      '<div class="legend"><i></i>Range <i class="b"></i>Most likely</div>' +
      '<div style="margin-top:12px"><span class="pill2' +
      (warn ? ' warn' : '') +
      '">' +
      (warn ? 'Watch: ' : '') +
      'Worst case dips to ' +
      eur(f.minLow) +
      ' by end of ' +
      worst.label +
      '</span></div>' +
      '<div style="margin-top:12px;display:flex;gap:16px;flex-wrap:wrap"><button class="link" id="fc-assume">How it’s worked out</button><button class="link" data-basis="fc">View basis ↗</button></div>' +
      '<ul class="assume" id="fc-list" hidden>' +
      f.assumptions.map((a) => '<li>' + esc(a) + '</li>').join('') +
      '<li>' +
      esc(f.confidenceWhy) +
      '. A pattern from past turnover, not a promise.</li></ul></div>' +
      '<div class="card" id="budget-card" style="margin-top:12px">' +
      budgetBody() +
      '</div>'
    );
  }
  function budgetBody() {
    const g = bgrowth == null ? Math.round(eng.model.growth * 100) : bgrowth;
    return (
      '<div id="bud-dyn">' +
      budgetDyn(g) +
      '</div><div class="slide"><label for="bg">Growth on 2026</label><input type="range" id="bg" min="0" max="20" step="1" value="' +
      g +
      '"><b id="bgv">' +
      g +
      '%</b></div>' +
      '<div style="margin-top:10px"><button class="link" data-basis="bud">View basis ↗</button></div>'
    );
  }
  function budgetDyn(g) {
    const b = eng.budget(g / 100),
      mx = Math.max.apply(
        null,
        b.months.map((m) => m.share)
      );
    return (
      '<div class="fc-head"><div><b>Budget 2027</b></div><div style="text-align:right"><b>' +
      eur(b.annual) +
      '</b><small>vs ' +
      eur(b.prior) +
      ' in 2026</small></div></div>' +
      '<div class="bud" role="img" aria-label="Budget by month. Busiest month: ' +
      b.peak +
      '">' +
      b.months
        .map(
          (m) =>
            '<div class="' +
            (m.label === b.peak ? 'pk' : '') +
            '" title="' +
            m.label +
            ': ' +
            eur(m.amount) +
            ' (' +
            (m.share * 100).toFixed(1) +
            '%)"><i style="height:' +
            Math.round((m.share / mx) * 80) +
            'px"></i>' +
            m.label[0] +
            '</div>'
        )
        .join('') +
      '</div>' +
      ''
    );
  }

  function itemCard(it, n) {
    let versus = '';
    if (it.trust === 'conflict' && it.paidFacts && it.paidFacts.length) {
      const led = it.facts.find((f) => f.kind === 'ledger_entry');
      const bankCr = it.facts.filter((f) => f.kind === 'bank_credit');
      const chk = it.facts.find((f) => f.kind === 'bank_check');
      const claims = it.paidFacts.filter((f) => f.kind !== 'bank_credit');
      const maxAmt = (l) =>
        Math.max.apply(
          null,
          l.map((f) => f.amount || 0)
        );
      const cols = [{ t: 'Your ledger says', h: 'Open · ' + eur(it.amount), ids: [led.id] }];
      if (claims.length)
        cols.push({
          t: claims.map(srcName).join(' and ') + (claims.length > 1 ? ' say' : ' says'),
          h: (claims.some((f) => f.claim === 'partial_paid') ? 'Part paid · ' : 'Paid · ') + eur(maxAmt(claims)),
          ids: claims.map((f) => f.id)
        });
      if (bankCr.length) cols.push({ t: 'Bank feed says', h: 'Received · ' + eur(maxAmt(bankCr)), ids: bankCr.map((f) => f.id) });
      else if (chk) cols.push({ t: 'Bank feed says', h: 'No matching credit', ids: [chk.id] });
      versus =
        '<div class="versus v' +
        cols.length +
        '">' +
        cols.map((c) => '<div><small>' + esc(c.t) + '</small><b>' + esc(c.h) + '</b>' + chips(c.ids) + '</div>').join('') +
        '</div>';
    }
    const p = it.parts;
    const why = p
      ? 'Score ' +
        it.score +
        ' = urgency ' +
        p.time +
        ' + size ' +
        p.size +
        (p.statutory ? ' + statutory deadline ' + p.statutory : '') +
        ', × reliability ' +
        p.reliability +
        (p.note ? ' (' + p.note + ')' : '') +
        (p.bonus ? ', + ' + p.bonus + (p.note ? ' for the bookkeeping fix' : ' because someone has to decide which source is right') : '') +
        '. Overdue and large items rank higher; weak sources rank lower.'
      : '';
    const short = it.suggestion ? it.suggestion.text.split(/(?<=\.)\s/)[0] : '';
    const askBtn =
      '<button class="link" data-ask="' +
      esc(
        it.type === 'receivable' && it.trust !== 'conflict' && it.daysTo < 0 ? 'Draft a chase email for ' + it.party : 'What is the status of ' + it.ref + '?'
      ) +
      '">' +
      (it.type === 'receivable' && it.trust !== 'conflict' && it.daysTo < 0 ? 'Draft a chase' : 'Ask about this') +
      '</button>';
    return (
      '<article class="item ' +
      (it.confirmed ? 'single' : it.trust) +
      '"><div class="rank">' +
      (n || '·') +
      '</div><div class="body"><div class="top"><div><h3>' +
      esc(it.title) +
      '</h3>' +
      (n ? '' : '<p class="reason" style="margin-bottom:6px">' + esc(it.reason) + '</p>') +
      '</div>' +
      (it.amount != null && it.type !== 'info' && it.type !== 'forecast'
        ? '<div class="amt"><b>' + eur(it.amount) + '</b><span>' + esc(it.when) + '</span></div>'
        : '') +
      '</div>' +
      '<div class="meta">' +
      badge(it, true) +
      '</div>' +
      '<div class="foot">' +
      suggestion(it, short) +
      '<button class="link" data-open="' +
      it.ref +
      '">Evidence ▾</button></div>' +
      '<div class="ev" id="ev-' +
      it.ref +
      '" hidden>' +
      (n ? '<p class="reason">' + esc(it.reason) + '</p>' : '') +
      versus +
      (it.strongest && it.type !== 'info' ? '<div class="strong">Strongest evidence: ' + esc(it.strongest) + '</div>' : '') +
      (versus ? '' : chips(it.factIds, 'Sources')) +
      '<div style="margin-top:10px;display:flex;gap:16px">' +
      (p ? '<button class="link" data-why="' + it.ref + '">Why this rank</button>' : '') +
      askBtn +
      '</div>' +
      '<div class="why" id="why-' +
      it.ref +
      '" hidden>' +
      esc(why) +
      '</div></div></div></article>'
    );
  }

  function priorities() {
    const keep = (i) => filter === 'all' || (filter === 'conflict' && i.trust === 'conflict') || (filter === 'verified' && i.trust !== 'conflict');
    let n = 0,
      out =
        '<h1>Priorities</h1><p class="sub">Most urgent first.</p>' +
        '<div class="tools">' +
        [
          ['all', 'All'],
          ['conflict', 'Needs a decision'],
          ['verified', 'Verified']
        ]
          .map((f) => '<button class="pill ' + (filter === f[0] ? 'on' : '') + '" data-filter="' + f[0] + '">' + f[1] + '</button>')
          .join('') +
        '</div>';
    eng.buckets.forEach((b) => {
      const list = b.items.filter(keep);
      if (!list.length) return;
      const limit = shown[b.label] || PAGE;
      out +=
        '<h2>' +
        b.label +
        ' (' +
        list.length +
        ')</h2>' +
        list
          .slice(0, limit)
          .map((i) => itemCard(i, ++n))
          .join('') +
        (list.length > limit
          ? '<button class="btn ghost" data-more="' +
            esc(b.label) +
            '">Show ' +
            Math.min(PAGE, list.length - limit) +
            ' more of ' +
            (list.length - limit) +
            ' left</button>'
          : '');
    });
    out +=
      '<h2>Couldn’t verify (' +
      eng.unverified.length +
      ')</h2><div class="uv">' +
      (eng.unverified.length
        ? eng.unverified
            .slice(0, shown.unverified || PAGE)
            .map((i) => itemCard(i, 0))
            .join('') + (eng.unverified.length > (shown.unverified || PAGE) ? '<button class="btn ghost" data-more="unverified">Show more</button>' : '')
        : '<div class="empty">Everything has been checked.</div>') +
      '</div>';
    out +=
      '<h2>Ask</h2><div class="card"><form class="askbox" id="askform"><input id="q" placeholder="Ask about an invoice, a bill, the VAT return…" autocomplete="off"><button class="btn">Ask</button></form>' +
      '<div class="sugg">' +
      ['What changed since Friday?', 'Are there any conflicts?', 'What’s the outlook for the next 90 days?', 'When is the VAT due?']
        .map((s) => '<button class="pill" data-ask="' + s + '">' + s + '</button>')
        .join('') +
      '</div>' +
      '<div class="thread" id="thread" aria-live="polite">' +
      thread.map(turn).join('') +
      '</div></div>';
    return out;
  }

  function turn(t) {
    const a = t.a,
      ok = a.claims.filter((c) => c.valid).length;
    return (
      '<div class="turn"><div class="q">' +
      esc(t.q) +
      '<span class="mode">' +
      (t.mode === 'live' ? 'Claude, live' : 'Local rules, offline demo') +
      '</span></div>' +
      a.claims
        .map(
          (c) =>
            '<div class="claim ' +
            (c.valid ? '' : 'bad') +
            '"><p>' +
            esc(c.text) +
            '</p>' +
            (c.valid ? chips(c.record_ids, 'Based on') : '<span class="tag">Not shown as fact: ' + esc(c.issues.join('; ')) + '</span>') +
            '</div>'
        )
        .join('') +
      (a.notes || []).map((n) => '<p class="empty">' + esc(n) + '</p>').join('') +
      (a.draft ? '<div class="draft"><b>Draft, not sent</b>' + esc(a.draft) + '</div>' : '') +
      '<div class="cov">' +
      (a.claims.length ? ok + ' of ' + a.claims.length + ' statements have a verified source. ' : '') +
      esc(a.coverage || '') +
      '</div></div>'
    );
  }

  /* drawer */
  let lastFocus = null;
  function openDrawer(html) {
    if (!$('#drawer').classList.contains('on')) lastFocus = document.activeElement;
    $('#drawer').innerHTML = '<button class="x" id="close" aria-label="Close details">×</button>' + html;
    $('#drawer').classList.add('on');
    $('#scrim').classList.add('on');
    $('#drawer').scrollTop = 0;
    $('#close').focus();
  }
  function closeDrawer() {
    if (!$('#drawer').classList.contains('on')) return;
    $('#drawer').classList.remove('on');
    $('#scrim').classList.remove('on');
    if (lastFocus && document.body.contains(lastFocus)) lastFocus.focus();
    lastFocus = null;
  }
  function factDrawer(id) {
    const f = eng.factById[id],
      a = eng.ageOf(f);
    const claimText =
      {
        outstanding: 'Still unpaid / outstanding',
        paid: 'Paid',
        partial_paid: 'Part paid',
        price_increase: 'Price increase announced',
        projection: 'Forecast figure'
      }[f.claim] || f.claim;
    let src = '';
    if (f.emailId) {
      const em = eng.data.EMAILS.find((e) => e.id === f.emailId);
      const body = esc(em.body).replace(esc(f.snippet), '<mark>' + esc(f.snippet) + '</mark>');
      src =
        '<h2>Full email</h2><div class="mail"><b>' +
        esc(em.subject) +
        '</b>\n' +
        esc(em.from) +
        ' → ' +
        esc(em.to) +
        '\n' +
        esc(fd(em.date, true)) +
        '\n\n' +
        body +
        '</div>';
    }
    openDrawer(
      '<div class="srclabel" style="margin-top:0">Source</div><h3>' +
        esc(f.summary) +
        '</h3><div class="sub">' +
        esc(srcName(f)) +
        ' · ' +
        esc(f.origin) +
        '</div>' +
        '<dl><dt>Date</dt><dd>' +
        esc(fd(f.date, true)) +
        ' · <b>' +
        a.label +
        ' old</b>' +
        (a.cls === 'old' ? ' (stale)' : '') +
        '</dd><dt>Reference</dt><dd>' +
        esc(f.ref || 'n/a') +
        '</dd><dt>Party</dt><dd>' +
        esc(f.party || 'n/a') +
        '</dd><dt>What it says</dt><dd>' +
        esc(claimText) +
        '</dd>' +
        (f.amount != null ? '<dt>Amount</dt><dd>' + eur(f.amount) + '</dd>' : '') +
        (f.dueDate ? '<dt>Due</dt><dd>' + fd(f.dueDate) + '</dd>' : '') +
        '</dl>' +
        '<h2 style="margin-top:8px">Exact text in the source</h2><blockquote>' +
        esc(f.snippet) +
        '</blockquote>' +
        src +
        '<p class="note">Trueline reads your sources and never changes them. If this looks wrong, the source itself is what needs fixing.</p>'
    );
  }
  function listDrawer(title, sub, list) {
    openDrawer(
      '<h3>' +
        esc(title) +
        '</h3><div class="sub">' +
        esc(sub) +
        '</div>' +
        (list.length
          ? list
              .map(
                (i) =>
                  '<div class="item ' +
                  i.trust +
                  '" style="margin:10px 0"><div class="body"><div class="top"><div><h3 style="font-size:15px">' +
                  esc(i.title) +
                  '</h3></div>' +
                  (i.amount != null && i.type !== 'info' && i.type !== 'forecast'
                    ? '<div class="amt"><b style="font-size:15px">' + eur(i.amount) + '</b></div>'
                    : '') +
                  '</div><div class="meta" style="margin-top:8px">' +
                  badge(i) +
                  '</div><div style="margin-top:8px">' +
                  chips(i.factIds) +
                  '</div></div></div>'
              )
              .join('')
          : '<div class="empty">Nothing here.</div>')
    );
  }
  function metricDrawer(k) {
    const m = eng.mis[k];
    if (k === 'bank')
      return openDrawer(
        '<h3>In the bank: ' +
          eur(m.value) +
          '</h3><div class="sub">Balance from the live bank feed. The bank is the strongest evidence in Trueline because it shows what actually arrived.</div>' +
          chips(m.factIds, 'Source')
      );
    if (k === 'overdue')
      return listDrawer(
        'Cash at risk: ' + eur(m.value),
        'Overdue invoices, counting only money that has not reached the bank. Tap a source to see it.',
        m.items
      );
    if (k === 'health')
      return listDrawer(
        'Data health',
        m.verified + ' of ' + m.total + ' checks passed. A check passes when two sources agree, or the ledger is the only record and is fresh.',
        eng.items.filter((i) => !i.closed)
      );
    listDrawer(m.label + ': ' + eur(m.value), 'Every item below is added into this number. Tap a source to see it.', m.items);
  }

  function changesDrawer() {
    openDrawer(
      '<h3>Since your last brief</h3><div class="sub">' +
        esc(fd(eng.data.LAST_BRIEF_AT, true)) +
        '</div>' +
        eng.changes
          .map(
            (f) =>
              '<div class="chg"><small>' +
              esc(fd(f.date)) +
              ' · ' +
              esc(srcName(f)) +
              '</small><b style="font-weight:500">' +
              esc(f.summary) +
              '</b> <button class="viewsrc" data-fact="' +
              f.id +
              '">View source <span aria-hidden="true">↗</span></button></div>'
          )
          .join('')
    );
  }
  function histDrawer(ref) {
    const it = eng.items.find((i) => i.ref === ref),
      s = it && it.suggestion;
    if (!s) return;
    openDrawer(
      '<h3>Why we suggest this</h3><div class="sub">' +
        esc(s.text) +
        '</div><p class="note" style="margin-top:0">' +
        (s.n < 3 ? 'Small sample, so treat it as a hint. ' : '') +
        'This comes from your own action log: ' +
        s.wins +
        ' of ' +
        s.n +
        ' similar past cases went the way the suggestion says. Nothing here is a prediction about this customer.</p>' +
        chips(s.evidence, 'Past cases')
    );
  }
  function prepDrawer() {
    openDrawer(
      '<h3>Prepared actions</h3><div class="sub">Drafts and notes Trueline has written for you. It never sends, pays or changes anything: you do that yourself.</div>' +
        (prepared.length
          ? prepared
              .slice()
              .reverse()
              .map(
                (x, i) =>
                  '<div class="prep"><div class="ph"><b>' +
                  esc(x.button.title) +
                  '</b><span class="tag2 k">' +
                  KIND[x.button.kind] +
                  '</span><span class="tag2">Not sent</span></div><div class="draft">' +
                  esc(x.button.body) +
                  '</div><div style="margin-top:8px;display:flex;gap:12px"><button class="btn sm ghost" data-copy="' +
                  (prepared.length - 1 - i) +
                  '">Copy</button><button class="link" data-unprep="' +
                  (prepared.length - 1 - i) +
                  '">Remove</button></div></div>'
              )
              .join('')
          : '<div class="empty">Nothing prepared yet. Use the button on any suggestion in Priorities.</div>')
    );
  }
  function basisDrawer(k) {
    const ids = k === 'bud' ? eng.budget().basisIds : eng.forecast.basisIds;
    openDrawer(
      '<h3>' +
        (k === 'bud' ? 'Budget basis' : 'Outlook basis') +
        '</h3><div class="sub">' +
        (k === 'bud'
          ? 'Monthly shares come from these P&L years. Change the slider and the same shares are applied to a new total.'
          : 'Past turnover sets the pattern, today’s bank balance is the starting point, and the VAT bill comes from your workings.') +
        '</div>' +
        chips(ids, 'Sources')
    );
  }
  function emailDrawer() {
    const m = eng.briefEmail();
    openDrawer(
      '<h3>The 06:30 email</h3><div class="sub">For the owner who never opens the app.</div><div class="email"><div class="eh"><b>' +
        esc(m.subject) +
        '</b>brief@trueline · to the owner</div><div class="eb">' +
        '<div class="eh2">Do today</div>' +
        m.rows
          .map(
            (r, n) =>
              '<div class="er"><span class="en">' +
              (n + 1) +
              '</span><div><b>' +
              esc(r.title) +
              ' · ' +
              eur(r.amount) +
              '</b><span class="' +
              (r.flag ? 'ef' : '') +
              '">' +
              esc(r.note) +
              '</span><em>→ ' +
              esc(r.action) +
              '</em></div></div>'
          )
          .join('') +
        '<div class="eh2">Cash</div><div class="ec"><div><small>In the bank</small><b>' +
        eur(m.cash.bank) +
        '</b></div><div><small>At risk</small><b>' +
        eur(m.cash.risk) +
        '</b></div></div>' +
        (m.unverified
          ? '<div class="eh2">Couldn’t verify</div><div class="ep">' + m.unverified + ' items held back until a second source confirms.</div>'
          : '') +
        '<div class="ep" style="margin-top:14px"><button class="viewsrc" data-go="overview">Open the full brief →</button></div></div></div>'
    );
  }
  function howDrawer() {
    openDrawer(
      '<h3>How we check</h3><div class="sub">Trueline never asks you to take a number on trust. Every line is checked in the same four steps.</div><div class="hw">' +
        '<div><b>1. Pull from every place the answer could be</b>Bank feed, ledger, spreadsheets and inbox. Nothing is typed in by hand.</div>' +
        '<div><b>2. Compare, and rank the evidence</b>The bank shows what actually arrived, so it outranks the ledger, which outranks spreadsheets, which outrank an email. When two sources disagree you see both side by side.</div>' +
        '<div><b>3. Label how far to trust each line</b><ol><li><span class="badge agree">Sources agree</span> two or more sources say the same thing</li><li><span class="badge record">Ledger only</span> one fresh record, nothing contradicts it</li><li><span class="badge conflict">Sources conflict</span> someone has to decide which is right</li><li><span class="badge single">Unconfirmed</span> or stale: shown, but kept out of the ranking</li></ol></div>' +
        '<div><b>4. Cite, or say nothing</b>Answers to your questions must point to records. A statement with no record behind it, or a number that does not match its record, is not shown as fact. When there is no data, the answer is “I can’t verify that”.</div></div>' +
        '<p class="note">The ranking, the trust labels and the forecast are plain rules and arithmetic you can read. A language model only words the answers, and its output is checked against the records before you see it.</p>'
    );
  }
  let toastT;
  function toast(msg) {
    let t = document.querySelector('.toast');
    if (!t) {
      t = document.createElement('div');
      t.className = 'toast';
      t.setAttribute('role', 'status');
      t.setAttribute('aria-live', 'polite');
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastT);
    toastT = setTimeout(() => {
      t.hidden = true;
    }, 2200);
  }

  /* ask */
  async function ask(q) {
    if (!q.trim()) return;
    const mode = 'local';
    const a = eng.askLocal(q);
    thread.push({ q, a, mode });
    render();
    const t = document.querySelector('#thread .turn:last-child');
    if (t) t.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  /* ---- server calls ---- */
  const FILE_KIND = { ledger: 'Invoices and bills', bank: 'Bank transactions', pnl: 'Monthly profit and loss', emails: 'Email' };
  const failures = [];
  let pid = 0;
  async function api(path, opts) {
    const o = Object.assign({ method: 'GET', headers: {} }, opts);
    if (o.method !== 'GET') o.headers['X-Requested-With'] = 'trueline';
    if (o.json) {
      o.headers['Content-Type'] = 'application/json';
      o.body = JSON.stringify(o.json);
    }
    const r = await fetch('/api' + path, o);
    let j = null;
    try {
      j = await r.json();
    } catch (e) {
      /* not JSON */
    }
    if (r.status === 401 && !/^\/(login|signup|account)/.test(path)) {
      session.authed = false;
      render();
      throw new Error('auth');
    }
    if (!r.ok) throw new Error((j && j.error) || 'Request failed (' + r.status + ')');
    return j;
  }
  async function loadAll() {
    const [w, d, a] = await Promise.all([api('/workspace'), api('/dataset'), api('/account')]);
    ws = w;
    acct = a;
    eng = E.create(d.dataset);
  }
  async function reload() {
    try {
      await loadAll();
    } catch (e) {
      if (e.message !== 'auth') toast(e.message);
    }
    render();
  }
  async function boot() {
    if (STATIC) {
      ws = Object.assign({ samples: [], limits: { maxUploadMb: 0 } }, STATIC.workspace);
      eng = E.create(STATIC.dataset);
      return render();
    }
    try {
      session = await api('/session');
    } catch (e) {
      toast('Cannot reach the server.');
    }
    const q = new URLSearchParams(location.search).get('google');
    if (q) {
      toast(GOOGLE_MSG[q] || 'Google: ' + q);
      history.replaceState(null, '', location.pathname + '#account');
      view = 'account';
    }
    if (session.authed) await reload();
    else render();
  }

  /* ---- uploads ---- */
  const choiceFrom = (info) => {
    const idx = info.table || 0,
      t = info.tables[idx];
    if (!t) return {};
    const p = t.proposals[0];
    return { kind: p.kind, table: idx, mapping: p.mapping || {}, options: Object.assign({}, p.layout ? { layout: p.layout } : {}, p.options) };
  };
  async function commit(file, choice) {
    const f = new FormData();
    f.append('file', file);
    f.append('choice', JSON.stringify(choice));
    return api('/upload/commit', { method: 'POST', body: f });
  }
  async function addFile(file) {
    const f = new FormData();
    f.append('file', file);
    try {
      const info = await api('/upload/inspect', { method: 'POST', body: f });
      const t = info.tables.length ? info.tables[info.table || 0] : null;
      const p = t && t.proposals[0];
      if (!t || (p.kind && !p.missing.length && p.confidence >= 0.7)) await commit(file, t ? choiceFrom(info) : {});
      else pending.push({ id: ++pid, file, info, choice: choiceFrom(info) });
    } catch (e) {
      if (e.message !== 'auth') failures.push({ name: file.name, msg: e.message });
    }
  }
  async function handleFiles(list) {
    const files = Array.from(list);
    if (!files.length) return;
    view = 'account'; // stay on the account page so any questions about the files are visible
    location.hash = 'account';
    busy = true;
    render();
    for (const f of files) await addFile(f);
    busy = false;
    await reload();
  }

  /* ---- views ---- */
  function loginView() {
    const up = authMode === 'signup';
    return (
      '<section class="card login"><h1>' +
      (up ? 'Create your account' : 'Sign in') +
      '</h1><p class="sub">' +
      (up ? 'Your files and connections are private to your account.' : 'Welcome back.') +
      '</p><form id="loginform"><label class="fld">Email<input type="email" id="em" autocomplete="email" required maxlength="254"></label>' +
      '<label class="fld">Password<input type="password" id="pw" autocomplete="' +
      (up ? 'new-password' : 'current-password') +
      '" required minlength="' +
      (up ? 10 : 1) +
      '" maxlength="200"' +
      (up ? ' aria-describedby="pwhelp"' : '') +
      '></label>' +
      (up ? '<small class="help" id="pwhelp">At least 10 characters. A short sentence works well.</small>' : '') +
      (up && session.signup.codeRequired ? '<label class="fld">Invite code<input id="code" required autocomplete="off"></label>' : '') +
      '<button class="btn" type="submit">' +
      (up ? 'Create account' : 'Sign in') +
      '</button><p class="err" id="loginerr" role="alert"></p></form>' +
      (session.signup.open
        ? '<p class="sub swap">' +
          (up ? 'Already have an account? ' : 'New here? ') +
          '<button class="link" data-auth="' +
          (up ? 'signin' : 'signup') +
          '">' +
          (up ? 'Sign in' : 'Create an account') +
          '</button></p>'
        : '') +
      '<p class="note">Passwords are stored as salted scrypt hashes, never in plain text. Connected-service tokens are encrypted.</p></section>'
    );
  }
  function srcRow(s) {
    const issues = (s.notes || []).concat((s.issues || []).map((i) => 'Row ' + i.row + ': ' + i.message));
    const range = s.range ? s.range.from + ' to ' + s.range.to : '';
    return (
      '<li class="srcrow"><div><b>' +
      esc(s.file) +
      '</b><small>' +
      FILE_KIND[s.kind] +
      ' · ' +
      s.stats.accepted +
      ' read' +
      (s.stats.skipped ? ', ' + s.stats.skipped + ' skipped' : '') +
      (range ? ' · ' + range : '') +
      '</small>' +
      (issues.length
        ? '<details><summary>' + plural(issues.length, 'note') + '</summary><ul>' + issues.map((m) => '<li>' + esc(m) + '</li>').join('') + '</ul></details>'
        : '') +
      '</div>' +
      '<button class="link" data-act="remove" data-id="' +
      esc(s.id) +
      '" aria-label="Remove ' +
      esc(s.file) +
      '">Remove</button></li>'
    );
  }
  function pendingCard(p) {
    const info = p.info,
      t = info.tables[p.choice.table],
      kind = p.choice.kind;
    const fields = kind ? info.fields[kind] : [];
    const opts = (sel) =>
      '<option value="">Not in this file</option>' +
      t.headers.map((h, i) => '<option value="' + i + '"' + (sel === i ? ' selected' : '') + '>' + esc(h) + '</option>').join('');
    return (
      '<div class="card pend" data-pid="' +
      p.id +
      '"><h3>' +
      esc(p.file.name) +
      '</h3><p class="sub">We are not sure what this is. Tell us, and match the columns.</p>' +
      (info.tables.length > 1
        ? '<label class="fld">Sheet<select data-pa="sheet">' +
          info.tables
            .map((x, i) => '<option value="' + i + '"' + (i === p.choice.table ? ' selected' : '') + '>' + esc(x.name || 'Sheet ' + (i + 1)) + '</option>')
            .join('') +
          '</select></label>'
        : '') +
      '<label class="fld">This file contains<select data-pa="kind"><option value="">Choose…</option>' +
      ['ledger', 'bank', 'pnl'].map((k) => '<option value="' + k + '"' + (k === kind ? ' selected' : '') + '>' + FILE_KIND[k] + '</option>').join('') +
      '</select></label>' +
      (fields.length
        ? '<div class="map">' +
          fields
            .map(
              (f) =>
                '<label class="fld">' +
                esc(f.label) +
                (f.required ? ' *' : '') +
                '<select data-pa="field" data-field="' +
                f.field +
                '">' +
                opts(p.choice.mapping[f.field]) +
                '</select></label>'
            )
            .join('') +
          '</div>'
        : '') +
      '<div class="tbl"><table><thead><tr>' +
      t.headers.map((h) => '<th>' + esc(h) + '</th>').join('') +
      '</tr></thead><tbody>' +
      t.preview.map((r) => '<tr>' + r.map((c) => '<td>' + esc(c) + '</td>').join('') + '</tr>').join('') +
      '</tbody></table></div>' +
      '<div class="row"><button class="btn" data-act="usepend" data-id="' +
      p.id +
      '">Use this file</button><button class="btn ghost" data-act="droppend" data-id="' +
      p.id +
      '">Skip</button></div></div>'
    );
  }
  function settingsForm() {
    const s = ws.settings;
    const f = (id, label, val, attrs) =>
      '<label class="fld">' + label + '<input id="st-' + id + '" value="' + esc(val == null ? '' : val) + '" ' + (attrs || '') + '></label>';
    return (
      '<form id="settingsform" class="card"><div class="map">' +
      f('company', 'Company name', s.company, 'maxlength="80"') +
      '<label class="fld">Currency<select id="st-currency">' +
      ['EUR', 'GBP', 'USD'].map((c) => '<option' + (c === s.currency ? ' selected' : '') + '>' + c + '</option>').join('') +
      '</select></label>' +
      f('asOf', 'Treat this date as today (blank = real today)', s.asOf, 'type="date"') +
      f('costOfSalesPct', 'Cost of sales, share of turnover (0 to 1)', s.costOfSalesPct, 'type="number" step="0.01" min="0" max="1"') +
      f('overheadsMonthly', 'Overheads per month', s.overheadsMonthly, 'type="number" min="0"') +
      f('staleDays', 'Treat data older than this as stale (days)', s.staleDays, 'type="number" min="1" max="60"') +
      f('termsDays', 'Assumed payment terms when missing (days)', s.termsDays, 'type="number" min="0" max="180"') +
      f('emailDomain', 'Your email domain (to tell sent from received)', s.emailDomain, 'placeholder="yourcompany.com"') +
      '</div><button class="btn" type="submit">Save settings</button></form>'
    );
  }
  function staticDataView() {
    return (
      '<h1>Your account</h1><p class="sub">This hosted demo is read-only and preloaded with a sample. To use your own files, run Trueline yourself (see the README).</p>' +
      '<div class="card"><b>' +
      esc(STATIC.title || 'Sample') +
      '</b><p class="sub">' +
      esc(STATIC.description || '') +
      '</p></div>' +
      '<h2>Files in this sample</h2><ul class="srclist card">' +
      ws.sources
        .map(srcRow)
        .join('')
        .replace(/<button class="link"[^>]*>Remove<\/button>/g, '') +
      '</ul>'
    );
  }
  function dataView() {
    if (STATIC) return staticDataView();
    const has = ws.sources.length > 0;
    return (
      '<h2 id="files">Files</h2><p class="sub">Drop in the files you already have. Every line in your brief points back to the file and row it came from.</p>' +
      '<label class="drop" id="drop" for="file"><b>' +
      (busy ? 'Reading files…' : 'Drop files here, or click to choose') +
      '</b><small>CSV, Excel (.xlsx), bank files (.ofx, .qfx) and emails (.eml). Up to ' +
      ws.limits.maxUploadMb +
      ' MB each.</small>' +
      '<input type="file" id="file" multiple accept=".csv,.tsv,.txt,.xlsx,.xlsm,.ofx,.qfx,.eml" hidden></label>' +
      failures
        .map(
          (x, i) =>
            '<div class="alert" role="alert"><b>' +
            esc(x.name) +
            '</b>: ' +
            esc(x.msg) +
            ' <button class="link" data-act="dismiss" data-id="' +
            i +
            '">Dismiss</button></div>'
        )
        .join('') +
      pending.map(pendingCard).join('') +
      '<h2>Connected files</h2>' +
      (has
        ? '<ul class="srclist card">' +
          ws.sources.map(srcRow).join('') +
          '</ul><p class="row"><button class="link" data-act="clear">Remove all files</button></p>'
        : '<p class="note">No files yet. You need at least an invoice list to get a brief. A bank statement adds the cash position; monthly profit and loss adds the outlook.</p>') +
      '<h2>Or try a sample</h2>' +
      ws.samples
        .map(
          (x) =>
            '<div class="card sample"><div><b>' +
            esc(x.title) +
            '</b><p class="sub">' +
            esc(x.description) +
            '</p></div><button class="btn ghost" data-act="sample" data-id="' +
            esc(x.name) +
            '">Load sample</button></div>'
        )
        .join('') +
      '<h2>Settings</h2>' +
      settingsForm()
    );
  }
  function accountView() {
    if (STATIC)
      return (
        staticDataView() +
        '<p class="note">Accounts, Google Calendar, Tasks and Docs sync, inbound email, webhooks and the MCP connection need the hosted app.</p>'
      );
    return (
      '<div class="acc-head"><div><h1>Your account</h1><p class="sub">Signed in as <b>' +
      esc(session.user ? session.user.email : '') +
      '</b></p></div><button class="btn ghost" id="b-logout">Sign out</button></div>' +
      '<nav class="toc" aria-label="On this page"><a href="#files">Files</a><a href="#connections">Connections</a><a href="#security">Security</a></nav>' +
      dataView() +
      connectionsView() +
      securityView()
    );
  }
  const GOOGLE_MSG = {
    connected: 'Google connected. Your calendar, tasks and brief doc are being filled now.',
    denied: 'Google was not connected: permission was not given.',
    expired: 'That Google sign-in took too long or was for another account. Try again.',
    norefresh: 'Google did not grant offline access. Remove Trueline at myaccount.google.com/permissions and connect again.',
    failed: 'Google could not be connected. Try again in a minute.',
    unconfigured: 'Google is not set up on this server yet. The administrator needs to add a Google OAuth client.'
  };
  const ago = (iso) => (iso ? fd(iso, true) : 'never');
  function copyRow(id, value, label) {
    return (
      '<div class="copyrow"><input id="' +
      id +
      '" value="' +
      esc(value) +
      '" readonly aria-label="' +
      esc(label) +
      '"><button class="btn ghost sm" data-copyfrom="' +
      id +
      '">Copy</button></div>'
    );
  }
  function connectionsView() {
    const a = acct;
    if (!a) return '';
    const g = a.google;
    const google =
      '<div class="card conn"><div class="conn-h"><h3>Google Calendar, Tasks and Docs</h3><span class="badge ' +
      (g.connected ? (g.lastError ? 'conflict' : 'agree') : 'single') +
      '">' +
      (g.connected ? (g.lastError ? 'Needs attention' : 'Connected') : 'Not connected') +
      '</span></div>' +
      '<p class="sub">Bills and tax due in the next 60 days and your biggest expected payments go into a <b>Trueline</b> calendar with reminders. Today’s actions go into Google Tasks (where Google Reminders now live). The brief is kept up to date in a Google Doc. It updates by itself after every upload or forwarded email, and every few hours.</p>' +
      (g.connected
        ? '<ul class="facts"><li>Account: ' +
          esc(g.account || 'Google') +
          '</li><li>Last sync: ' +
          ago(g.lastSync) +
          (g.counts ? ' · ' + plural(g.counts.events, 'calendar date') + ', ' + plural(g.counts.tasks, 'task') : '') +
          '</li>' +
          (g.docUrl ? '<li><a href="' + esc(g.docUrl) + '" target="_blank" rel="noopener">Open the brief in Google Docs</a></li>' : '') +
          '</ul>' +
          (g.lastError ? '<div class="alert" role="alert">' + esc(g.lastError) + '</div>' : '') +
          '<div class="row">' +
          (g.needsReconnect ? '<a class="btn" href="/api/google/start">Connect again</a>' : '<button class="btn" data-acc="gsync">Sync now</button>') +
          '<button class="btn ghost" data-acc="gdisconnect">Disconnect</button></div>'
        : g.configured
          ? '<div class="row"><a class="btn" href="/api/google/start">Connect Google</a></div><p class="note">Trueline asks only for calendars and docs it creates itself, plus Tasks. It cannot read your other calendars, docs or email.</p>'
          : '<p class="note">Not available yet: the server administrator has to add a Google OAuth client (see docs/GOOGLE.md).</p>') +
      '</div>';
    const inbound =
      '<div class="card conn"><div class="conn-h"><h3>Forward bills and emails automatically</h3><span class="badge ' +
      (a.inboundUrl ? 'agree">On' : 'single">Off') +
      '</span></div><p class="sub">A private link that accepts emails and files. Point a mail-forwarding service, Zapier or Make at it, and every bill, remittance or statement that arrives is read, checked and synced with no clicks.</p>' +
      (a.inboundUrl
        ? copyRow('inb', a.inboundUrl, 'Your private inbound link') +
          '<p class="note">Send a raw email (Content-Type: message/rfc822) or files as multipart form data. Treat the link like a password.</p><div class="row"><button class="btn ghost" data-acc="inrotate">Make a new link</button><button class="link" data-acc="inoff">Turn off</button></div>'
        : '<div class="row"><button class="btn" data-acc="inrotate">Create my inbound link</button></div>') +
      '</div>';
    const hooks =
      '<div class="card conn"><div class="conn-h"><h3>Other services (webhooks)</h3><span class="badge ' +
      (a.webhooks.length ? 'agree">' + a.webhooks.length + ' on' : 'single">Off') +
      '</span></div><p class="sub">After each update Trueline posts the brief as JSON to these addresses. Use it to reach Slack, Teams, Outlook, Notion, a CRM or anything Zapier, Make or n8n can reach. Each post is signed (X-Trueline-Signature).</p>' +
      (a.webhooks.length
        ? '<ul class="srclist">' +
          a.webhooks
            .map(
              (h) =>
                '<li class="srcrow"><div><b>' +
                esc(h.name) +
                '</b><small>' +
                esc(h.host) +
                ' · last post: ' +
                (h.lastStatus ? esc(h.lastStatus) + ', ' + ago(h.lastAt) : 'not yet') +
                '</small></div><div><button class="link" data-acc="htest" data-id="' +
                esc(h.id) +
                '">Send test</button> <button class="link" data-acc="hdel" data-id="' +
                esc(h.id) +
                '">Remove</button></div></li>'
            )
            .join('') +
          '</ul>'
        : '') +
      '<form id="hookform" class="map"><label class="fld">Name<input id="h-name" maxlength="60" placeholder="Slack via Zapier"></label><label class="fld">Address<input id="h-url" type="url" required placeholder="https://hooks.zapier.com/…"></label><div><button class="btn" type="submit">Add webhook</button></div></form>' +
      '</div>';
    const keys =
      '<div class="card conn"><div class="conn-h"><h3>AI assistants (MCP) and API</h3><span class="badge ' +
      (a.apiKeys.length ? 'agree">' + a.apiKeys.length + ' key' + (a.apiKeys.length > 1 ? 's' : '') : 'single">No keys') +
      '</span></div><p class="sub">Let Claude, Cursor or another MCP client read your brief and ask cited questions. Read-only: a key cannot change or send anything.</p>' +
      '<label class="fld">MCP server address</label>' +
      copyRow('mcpurl', a.mcpUrl, 'MCP server address') +
      '<label class="fld">Brief API (GET, JSON)</label>' +
      copyRow('apiurl', a.briefApiUrl, 'Brief API address') +
      (revealed
        ? '<div class="reveal" role="status"><b>Copy this key now. It will not be shown again.</b>' +
          copyRow('newkey', revealed.value, revealed.label) +
          (revealed.kind === 'key'
            ? '<p class="note">Claude Code: <code>claude mcp add --transport http trueline ' +
              esc(a.mcpUrl) +
              ' --header "Authorization: Bearer ' +
              esc(revealed.value) +
              '"</code></p>'
            : '<p class="note">Use this secret to check the X-Trueline-Signature header (HMAC-SHA256 of the body).</p>') +
          '<button class="link" data-acc="hide">I have saved it</button></div>'
        : '') +
      (a.apiKeys.length
        ? '<ul class="srclist">' +
          a.apiKeys
            .map(
              (k) =>
                '<li class="srcrow"><div><b>' +
                esc(k.name) +
                '</b><small>' +
                esc(k.prefix) +
                '… · created ' +
                ago(k.createdAt) +
                ' · last used ' +
                ago(k.lastUsedAt) +
                '</small></div><button class="link" data-acc="kdel" data-id="' +
                esc(k.id) +
                '">Revoke</button></li>'
            )
            .join('') +
          '</ul>'
        : '') +
      '<form id="keyform" class="row"><label class="fld grow">Key name<input id="k-name" maxlength="60" placeholder="Claude"></label><button class="btn" type="submit">Create key</button></form>' +
      '</div>';
    return '<h2 id="connections">Connections</h2>' + google + inbound + hooks + keys;
  }
  function securityView() {
    return (
      '<h2 id="security">Security</h2><form id="pwform" class="card map"><label class="fld">Current password<input type="password" id="pw-cur" autocomplete="current-password" required></label>' +
      '<label class="fld">New password (10+ characters)<input type="password" id="pw-new" autocomplete="new-password" minlength="10" maxlength="200" required></label>' +
      '<div><button class="btn" type="submit">Change password</button><p class="note">Changing it signs out every other device.</p></div></form>' +
      '<details class="card danger"><summary>Delete my account</summary><form id="delform" class="row"><label class="fld grow">Password<input type="password" id="del-pw" autocomplete="current-password" required></label><button class="btn danger" type="submit">Delete account and all files</button></form><p class="note">Removes your files, settings, keys and webhooks, and revokes Trueline’s Google access. This cannot be undone.</p></details>'
    );
  }
  async function accountAction(d) {
    try {
      if (d.acc === 'gsync') {
        toast('Syncing with Google…');
        const r = await api('/google/sync', { method: 'POST' });
        acct = r.account;
        const g = r.result && r.result.google;
        toast(g && g.error ? 'Google sync failed: ' + g.error : r.result.skipped ? 'Nothing to sync yet: ' + r.result.skipped + '.' : 'Google is up to date.');
      } else if (d.acc === 'gdisconnect') {
        if (!confirm('Disconnect Google? Trueline’s calendar, tasks and doc stay in your Google account; they just stop updating.')) return;
        acct = await api('/google', { method: 'DELETE' });
        toast('Google disconnected.');
      } else if (d.acc === 'inrotate') {
        if (acct.inboundUrl && !confirm('Make a new link? The old one stops working straight away.')) return;
        acct = await api('/inbound', { method: 'POST' });
        toast('Inbound link ready.');
      } else if (d.acc === 'inoff') {
        acct = await api('/inbound', { method: 'DELETE' });
        toast('Inbound link turned off.');
      } else if (d.acc === 'htest') {
        const r = await api('/webhooks/' + d.id + '/test', { method: 'POST' });
        acct = r.account;
        toast('Test sent: ' + r.status);
      } else if (d.acc === 'hdel') {
        acct = await api('/webhooks/' + d.id, { method: 'DELETE' });
      } else if (d.acc === 'kdel') {
        if (!confirm('Revoke this key? Anything using it stops working.')) return;
        acct = await api('/keys/' + d.id, { method: 'DELETE' });
      } else if (d.acc === 'hide') revealed = null;
    } catch (e) {
      if (e.message !== 'auth') toast(e.message);
    }
    render();
  }
  async function accountSubmit(id) {
    const v = (x) => document.getElementById(x).value;
    try {
      if (id === 'hookform') {
        const r = await api('/webhooks', { method: 'POST', json: { name: v('h-name'), url: v('h-url') } });
        acct = r.account;
        revealed = { kind: 'hook', value: r.signingSecret, label: 'Webhook signing secret' };
        toast('Webhook added.');
      } else if (id === 'keyform') {
        const r = await api('/keys', { method: 'POST', json: { name: v('k-name') } });
        acct = r.account;
        revealed = { kind: 'key', value: r.key, label: 'New API key' };
      } else if (id === 'pwform') {
        await api('/account/password', { method: 'PUT', json: { current: v('pw-cur'), next: v('pw-new') } });
        toast('Password changed. Other devices are signed out.');
      } else if (id === 'delform') {
        if (!confirm('Delete your account and every file? This cannot be undone.')) return;
        await api('/account', { method: 'DELETE', json: { password: v('del-pw') } });
        session = Object.assign(session, { authed: false, user: null });
        eng = null;
        toast('Account deleted.');
      }
    } catch (e) {
      if (e.message !== 'auth') toast(e.message);
    }
    render();
  }

  async function dataAction(d) {
    try {
      if (d.act === 'remove') {
        await api('/sources/' + d.id, { method: 'DELETE' });
        toast('Removed.');
      } else if (d.act === 'clear') {
        if (!confirm('Remove every uploaded file? Settings are kept.')) return;
        await api('/workspace', { method: 'DELETE' });
      } else if (d.act === 'sample') {
        busy = true;
        render();
        await api('/sample/' + d.id, { method: 'POST' });
        toast('Sample loaded.');
        busy = false;
        view = 'overview';
        location.hash = view;
      } else if (d.act === 'dismiss') {
        failures.splice(+d.id, 1);
        return render();
      } else if (d.act === 'droppend') {
        pending = pending.filter((p) => p.id !== +d.id);
        return render();
      } else if (d.act === 'usepend') {
        const p = pending.find((x) => x.id === +d.id);
        await commit(p.file, p.choice);
        pending = pending.filter((x) => x !== p);
        toast('Added ' + p.file.name + '.');
      }
    } catch (e) {
      busy = false;
      if (e.message !== 'auth') {
        failures.push({ name: d.act, msg: e.message });
      }
    }
    await reload();
  }
  function pendingChange(el) {
    const p = pending.find((x) => x.id === +el.closest('[data-pid]').dataset.pid),
      a = el.dataset.pa;
    if (a === 'kind') {
      p.choice.kind = el.value || null;
      const prop = p.info.tables[p.choice.table].proposals.find((x) => x.kind === el.value);
      p.choice.mapping = prop ? prop.mapping : {};
      p.choice.options = prop ? Object.assign({}, prop.layout ? { layout: prop.layout } : {}, prop.options) : {};
    } else if (a === 'sheet') {
      p.choice.table = +el.value;
      const prop = p.info.tables[p.choice.table].proposals[0];
      p.choice.kind = prop.kind;
      p.choice.mapping = prop.mapping;
    } else if (a === 'field') {
      if (el.value === '') delete p.choice.mapping[el.dataset.field];
      else p.choice.mapping[el.dataset.field] = +el.value;
    }
    render();
  }
  async function saveSettings() {
    const v = (id) => document.getElementById('st-' + id).value;
    const body = {
      company: v('company'),
      currency: v('currency'),
      asOf: v('asOf') || null,
      costOfSalesPct: v('costOfSalesPct'),
      overheadsMonthly: v('overheadsMonthly'),
      staleDays: v('staleDays'),
      termsDays: v('termsDays'),
      emailDomain: v('emailDomain')
    };
    try {
      await api('/settings', { method: 'PUT', json: body });
      toast('Settings saved.');
    } catch (e) {
      toast(e.message);
    }
    await reload();
  }
  async function login() {
    try {
      const body = { email: $('#em').value, password: $('#pw').value };
      if ($('#code')) body.code = $('#code').value;
      const r = await api(authMode === 'signup' ? '/signup' : '/login', { method: 'POST', json: body });
      session.authed = true;
      session.user = r.user;
      if (authMode === 'signup') view = 'account';
      await reload();
    } catch (e) {
      const el = $('#loginerr');
      if (el) el.textContent = e.message;
    }
  }

  /* wiring */
  function render() {
    if (!session.authed) {
      $('#main').innerHTML = loginView();
      $('#sync').textContent = '';
      return;
    }
    if (!eng) {
      $('#main').innerHTML = '<p class="note">Loading…</p>';
      return;
    }
    document.querySelectorAll('nav button').forEach((b) => {
      b.classList.toggle('on', b.dataset.view === view);
      if (b.dataset.view === view) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    $('#sync').textContent = eng ? 'As of ' + fd(eng.data.NOW, true) : '';
    const pc = $('#prepct');
    pc.textContent = prepared.length;
    pc.hidden = !prepared.length;
    const hasData = eng && eng.data.LEDGER.length > 0;
    const shown = hasData ? view : 'account'; // an empty workspace always lands on the account page, without losing the chosen view
    document.querySelectorAll('nav button').forEach((b2) => {
      b2.disabled = !hasData && b2.dataset.view !== 'account';
    });
    $('#main').innerHTML = shown === 'account' ? accountView() : shown === 'priorities' ? priorities() : overview();
  }
  document.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    const d = t.dataset;
    if (d.more) {
      shown[d.more] = (shown[d.more] || PAGE) + PAGE;
      render();
    } else if (d.act) dataAction(d);
    else if (d.acc) accountAction(d);
    else if (d.auth) {
      authMode = d.auth;
      render();
      $('#em').focus();
    } else if (d.copyfrom) {
      const inp = document.getElementById(d.copyfrom);
      inp.select();
      try {
        navigator.clipboard.writeText(inp.value);
        t.textContent = 'Copied';
      } catch (e) {
        /* clipboard blocked: the text is selected so the person can copy it */
      }
    } else if (t.id === 'b-logout') {
      api('/logout', { method: 'POST' }).finally(() => {
        session = Object.assign(session, { authed: false, user: null });
        eng = null;
        acct = null;
        render();
      });
    } else if (d.view || d.go) {
      view = d.view || d.go;
      location.hash = view;
      closeDrawer();
      render();
      window.scrollTo(0, 0);
    } else if (d.fact) factDrawer(d.fact);
    else if (d.metric) metricDrawer(d.metric);
    else if (d.age) {
      const a = eng.mis.ageing[+d.age];
      listDrawer(a.label + ': ' + eur(a.amount), 'Invoices in this group.', a.items);
    } else if (d.item) {
      view = 'priorities';
      location.hash = view;
      render();
      const el = document.getElementById('why-' + d.item);
      if (el) el.closest('.item').scrollIntoView({ block: 'center' });
    } else if (d.open) {
      const el = document.getElementById('ev-' + d.open);
      el.hidden = !el.hidden;
      t.textContent = el.hidden ? 'Evidence ▾' : 'Evidence ▴';
    } else if (d.changes) changesDrawer();
    else if (d.why) {
      const el = document.getElementById('why-' + d.why);
      el.hidden = !el.hidden;
    } else if (d.filter) {
      filter = d.filter;
      render();
    } else if (d.ask) {
      if (view !== 'priorities') {
        view = 'priorities';
        location.hash = view;
      }
      ask(d.ask);
    } else if (d.hist) histDrawer(d.hist);
    else if (d.prep) {
      const it = eng.items.find((i) => i.ref === d.prep);
      if (it && it.suggestion && it.suggestion.button) {
        if (!prepared.some((x) => x.ref === it.ref)) {
          prepared.push({ ref: it.ref, button: it.suggestion.button });
          toast('Prepared. Nothing was sent.');
          render();
        } else prepDrawer();
      }
    } else if (d.copy) {
      const x = prepared[+d.copy];
      try {
        navigator.clipboard.writeText(x.button.body);
      } catch (e) {
        /* storage unavailable: preferences just are not saved */
      }
      t.textContent = 'Copied';
    } else if (d.unprep) {
      prepared.splice(+d.unprep, 1);
      render();
      prepDrawer();
    } else if (d.basis) basisDrawer(d.basis);
    else if (t.id === 'fc-assume') {
      const l = $('#fc-list');
      l.hidden = !l.hidden;
    } else if (t.id === 'b-zoom') togglePop();
    else if (t.id === 'b-theme') {
      prefs.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      applyPrefs(true);
    } else if (d.zoom) {
      prefs.zoom = +d.zoom;
      applyPrefs(true);
    } else if (t.id === 't-reset') {
      prefs = { theme: prefs.theme, zoom: 1, contrast: false, motion: false };
      applyPrefs(true);
    } else if (t.id === 'b-prep') prepDrawer();
    else if (t.id === 'b-email') emailDrawer();
    else if (t.id === 'b-how') howDrawer();
    else if (t.id === 'close') closeDrawer();
  });
  document.addEventListener('input', (e) => {
    if (e.target.id === 'bg') {
      bgrowth = +e.target.value;
      $('#bud-dyn').innerHTML = budgetDyn(bgrowth);
      $('#bgv').textContent = bgrowth + '%';
    }
  });
  document.addEventListener('submit', (e) => {
    if (e.target.id === 'askform') {
      e.preventDefault();
      const v = $('#q').value;
      ask(v);
    }
  });
  $('#scrim').addEventListener('click', closeDrawer);
  document.addEventListener('change', (e) => {
    if (e.target.id === 't-contrast') {
      prefs.contrast = e.target.checked;
      applyPrefs(true);
    }
    if (e.target.id === 't-motion') {
      prefs.motion = e.target.checked;
      applyPrefs(true);
    }
  });
  document.addEventListener('click', (e) => {
    const pop = $('#pop');
    if (!pop.hidden && !e.target.closest('#pop') && !e.target.closest('#b-zoom')) ((pop.hidden = true), $('#b-zoom').setAttribute('aria-expanded', 'false'));
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('#pop').hidden) togglePop(false);
      else closeDrawer();
    }
    if (e.key === 'Tab' && $('#drawer').classList.contains('on')) {
      const f = $('#drawer').querySelectorAll('button,[href],input');
      if (!f.length) return;
      const first = f[0],
        last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      } else if (!$('#drawer').contains(document.activeElement)) {
        e.preventDefault();
        first.focus();
      }
    }
  });
  document.addEventListener('submit', (e) => {
    if (e.target.id === 'loginform') {
      e.preventDefault();
      login();
    } else if (e.target.id === 'settingsform') {
      e.preventDefault();
      saveSettings();
    } else if (['hookform', 'keyform', 'pwform', 'delform'].includes(e.target.id)) {
      e.preventDefault();
      accountSubmit(e.target.id);
    }
  });
  document.addEventListener('change', (e) => {
    if (e.target.id === 'file') {
      handleFiles(e.target.files);
      e.target.value = '';
    } else if (e.target.dataset && e.target.dataset.pa) pendingChange(e.target);
  });
  ['dragover', 'dragleave', 'drop'].forEach((ev) =>
    document.addEventListener(ev, (e) => {
      const z = e.target.closest && e.target.closest('#drop');
      if (!z) return;
      e.preventDefault();
      z.classList.toggle('over', ev === 'dragover');
      if (ev === 'drop') handleFiles(e.dataTransfer.files);
    })
  );
  window.addEventListener('hashchange', () => {
    const h = (location.hash || '#overview').slice(1);
    if (['overview', 'priorities', 'account'].includes(h)) {
      view = h;
      render();
    } else if (h === 'data') {
      view = 'account';
      render();
    }
  });
  if (view === 'data') view = 'account';
  if (view !== 'priorities' && view !== 'account') view = 'overview';
  applyPrefs(false);
  boot();
})();
