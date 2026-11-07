'use strict';

/**
 * Pure: turn the engine's view of the business into what other services should show.
 *  - events: bills, tax and large expected receipts with a due date in the next 60 days (calendar, with reminders)
 *  - tasks:  today's actions (Google Tasks is where Google Reminders now live)
 *  - doc:    the morning brief as plain text
 * Each entry has a stable key and a hash, so a sync only touches what changed.
 */
const crypto = require('node:crypto');
const { eur, fd } = require('../engine/engine');

const EVENT_DAYS = 60;
const RECEIPT_DAYS = 30;
const MAX_RECEIPTS = 15;
const MAX_EVENTS = 60;
const MAX_TASKS = 15;

const hash = (o) => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0, 16);
const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);

function plan(engine) {
  const today = engine.data.NOW.slice(0, 10);
  const open = engine.items.filter((i) => !i.closed && i.dueDate && i.daysTo != null);
  const company = engine.data.COMPANY || 'your company';

  const bills = open.filter((i) => (i.type === 'payable' || i.type === 'obligation') && i.daysTo >= 0 && i.daysTo <= EVENT_DAYS);
  const receipts = open
    .filter((i) => i.type === 'receivable' && i.daysTo >= 0 && i.daysTo <= RECEIPT_DAYS && i.trust !== 'conflict')
    .sort((a, b) => b.amount - a.amount)
    .slice(0, MAX_RECEIPTS);
  const event = (i, kind) => {
    const summary = (kind === 'pay' ? 'Pay ' : 'Expected from ') + i.party + ' · ' + eur(i.amount) + (i.ref ? ' (' + i.ref + ')' : '');
    const body = {
      summary,
      description: [
        i.reason,
        kind === 'pay' ? 'Action: ' + i.action : 'Due ' + fd(i.dueDate) + '. If it has not arrived, Trueline will flag it.',
        'From Trueline · ' + company
      ]
        .filter(Boolean)
        .join('\n\n'),
      start: { date: i.dueDate },
      end: { date: addDays(i.dueDate, 1) },
      transparency: 'transparent',
      reminders: {
        useDefault: false,
        overrides:
          kind === 'pay'
            ? [
                { method: 'popup', minutes: 3 * 1440 },
                { method: 'email', minutes: 1440 }
              ]
            : [{ method: 'popup', minutes: 0 }]
      },
      extendedProperties: { private: { trueline: i.type + ':' + i.ref } }
    };
    return { key: i.type + ':' + i.ref, hash: hash(body), body };
  };
  const events = bills
    .map((i) => event(i, 'pay'))
    .concat(receipts.map((i) => event(i, 'receive')))
    .slice(0, MAX_EVENTS);

  const actionOf = (i) => (i.suggestion ? i.suggestion.text : i.action).split(/(?<=\.)\s/)[0].replace(/\.$/, '');
  const todays = engine.buckets[0].items.filter((i) => !/^no action/i.test(actionOf(i))).slice(0, MAX_TASKS);
  const tasks = todays.map((i) => {
    const body = {
      title: actionOf(i) + ': ' + i.party + ' · ' + eur(i.amount),
      notes: [i.title, i.reason, 'Evidence is in Trueline. Nothing has been sent on your behalf.'].filter(Boolean).join('\n'),
      due: today + 'T00:00:00.000Z'
    };
    return { key: i.type + ':' + i.ref, hash: hash(body), body };
  });

  const m = engine.briefEmail();
  const upcoming = events.map((e) => fd(e.body.start.date) + '  ' + e.body.summary);
  const text = [
    'Trueline brief for ' + company,
    'As of ' + fd(engine.data.NOW, true) + '. ' + m.subject + '.',
    '',
    m.body,
    '',
    'UPCOMING DATES',
    upcoming.length ? upcoming.join('\n') : 'Nothing due in the next ' + EVENT_DAYS + ' days.',
    '',
    engine.coverage()
  ].join('\n');
  const doc = { title: 'Trueline brief · ' + company, text, hash: hash(text) };

  return { today, events, tasks, doc, subject: m.subject, rows: m.rows, cash: m.cash };
}

module.exports = { plan, EVENT_DAYS, MAX_EVENTS, MAX_TASKS };
