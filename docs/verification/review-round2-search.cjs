// Run from server/: node --expose-gc --env-file-if-exists=.env ../docs/verification/review-round2-search.cjs
// Read-only production routes over real HTTP/MySQL. Inventory fixtures never commit.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { fixture, imei } = require('../../server/test/helpers');
const { client, page } = require('../../server/test/page-helpers');
const { buildApp } = require('../../server/src/app');

(async () => {
  const f = await fixture(['boss', 'customer']);
  let connection, app;
  const evidence = { date: '2026-11-04', method: 'Real HTTP/MySQL, uncommitted runtime-account inventory fixtures, sequential local requests; timings are local observations rather than production load guarantees', checks: {}, samples: [] };
  try {
    const model = (await f.api('POST', '/models', { category: 'phone', name: '搜索审查_' + Date.now(), brandLabel: '搜索审查', series: '审查', copyTemplateId: 't_phone', tacs: [] })).data;
    assert.ok(model.id);
    connection = await f.pool.getConnection();
    await connection.beginTransaction();
    const [[seed]] = await connection.query("SELECT * FROM units WHERE status='in_stock' AND JSON_EXTRACT(attributes,'$.grade') IS NOT NULL LIMIT 1");
    assert.ok(seed);
    const columns = Object.keys(seed);
    evidence.seedRowJsonBytes = Buffer.byteLength(JSON.stringify(seed));
    const make = (i) => ({ ...seed, id: crypto.randomUUID(), imei1: imei(), imei2: null, model_id: model.id, retail: i === 0 ? 100 : 1000, wholesale: i === 0 ? 90 : 900, agent_base: i === 0 ? 90 : 900, cost: 50, ownership: 'own', condition_type: 'used', attributes: typeof seed.attributes === 'string' ? seed.attributes : JSON.stringify(seed.attributes), template_snapshot: typeof seed.template_snapshot === 'string' ? seed.template_snapshot : JSON.stringify(seed.template_snapshot), share_flags: JSON.stringify({ showInShop: true, sharePeer: true, shareAgent: false }), purchase_line_id: null, acceptance_item_id: null, inbound_operator_id: f.users.boss, supplier_id: null, created_at: i === 0 ? new Date('2020-01-01T00:00:00Z') : new Date(), price_version: 1 });
    const insert = (rows) => connection.query('INSERT INTO units (' + columns.map((k) => '`' + k + '`').join(',') + ') VALUES ?', [rows.map((r) => columns.map((k) => r[k]))]);
    const initial = Array.from({ length: 21 }, (_, i) => make(i));
    await insert(initial);
    app = await buildApp(f.cfg, { pool: connection });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const api = client({ api: async (method, url, body, role) => { const r = await fetch(origin + '/api/v1' + url, { method, headers: { Authorization: 'Bearer ' + f.tokens[role] } }); return { status: r.status, ...await r.json() }; } }, 'customer');
    const search = page('miniprogram/packages/shop/search/index.js', api, 'customer', { wx: { getStorageSync: () => [], setStorageSync: () => {}, removeStorageSync: () => {} } });
    await search.onLoad({ modelId: model.id });
    search.onPriceInput({ currentTarget: { dataset: { field: 'priceMax' } }, detail: { value: '100' } });
    assert.equal(search.data.priceMax, '');
    await search.load(false);
    assert.equal(search.data.list.length, 21);
    assert.ok(search.data.list.some((u) => u.id === initial[0].id));
    await search.onPick({ currentTarget: { dataset: { field: 'condition', value: 'used' } } });
    assert.equal(search.data.list.length, 20);
    assert.equal(search.data.priceMax, '');
    await search.onApplyPrice();
    assert.equal(search.data.list.length, 1);
    assert.equal(search.data.list[0].id, initial[0].id);
    evidence.checks.priceDraft = { unconfirmedPaginationTotal: 21, unconfirmedOtherFilterPageSize: 20, appliedMatches: 1, passed: true };

    let created = 21;
    for (const size of [2001, 10000, 20000]) {
      for (; created < size; created += Math.min(100, size - created)) {
        const count = Math.min(100, size - created);
        await insert(Array.from({ length: count }, (_, j) => make(created + j)));
      }
      for (const [kind, filter] of [['unfiltered', {}], ['broad_price', { priceMin: 0 }], ['battery', { batteryMin: 0 }], ['selective_price', { priceMax: 100 }]]) {
        const timings = [], heapDeltas = [];
        let total;
        for (let repeat = 0; repeat < 3; repeat++) {
          global.gc?.();
          const before = process.memoryUsage().heapUsed, start = performance.now();
          const result = await api.shop.units({ modelId: model.id, pageSize: 20, ...filter });
          timings.push(Math.round((performance.now() - start) * 10) / 10);
          heapDeltas.push(process.memoryUsage().heapUsed - before);
          total = result.total;
          if (kind === 'selective_price') { assert.equal(total, 1); assert.equal(result.list[0].id, initial[0].id); }
          if (kind === 'unfiltered' || kind === 'broad_price') assert.equal(total, size);
        }
        evidence.samples.push({ candidates: size, kind, returnedTotal: total, requestMs: timings, heapDeltaMiB: heapDeltas.map((n) => Math.round(n / 1024 / 1024 * 10) / 10) });
      }
    }
    evidence.checks.noCandidateCap = { candidates: 20000, fullTotal: 20000, olderPrice100Match: 1, passed: true };
    await app.close(); app = null;
    await connection.rollback();
    const [[remaining]] = await connection.query('SELECT COUNT(*) n FROM units WHERE model_id=?', [model.id]);
    assert.equal(Number(remaining.n), 0);
    evidence.inventoryTransactionRolledBack = true;
    fs.writeFileSync(path.join(__dirname, 'review-round2-search.json'), JSON.stringify(evidence, null, 2) + '\n');
    console.log(JSON.stringify(evidence, null, 2));
  } finally {
    if (app) await app.close();
    if (connection) { await connection.rollback(); connection.release(); }
    await f.close();
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
