'use strict';
// Demo-only helper for the Harbour & Co sample: Acme's payment arrives in the bank while the ledger is still behind.
// Lives with the sample, not in the engine, so the engine stays free of demo-specific data.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TRUELINE_DEMO = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  function applyAcmePaid(data) {
    data.BANK = data.BANK || { syncedAt: data.NOW, balance: 0, transactions: [] };
    if (!data.BANK.transactions.some((t) => t.reference === 'INV-1042')) {
      data.BANK.transactions.push({ id: 'TX-9990', date: '2026-11-09T06:05:00Z', counterparty: 'Acme Ltd', amount: 18400, reference: 'INV-1042' });
      data.BANK.balance += 18400;
    }
    return data;
  }
  return { applyAcmePaid };
});
