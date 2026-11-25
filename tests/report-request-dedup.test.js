const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(file, require) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram', file), 'utf8'), { module, require });
  return module.exports;
}

test('工作台合并同账号并发，写入和手动刷新后重新取数，切换账号不交付旧响应', async () => {
  const events = require('../miniprogram/utils/events');
  const calls = [];
  let user = { id: 'boss' };
  const dashboard = load('api/modules/dashboard.js', (name) => ({
    '../../utils/request': {
      http: { get: () => new Promise((resolve) => calls.push(resolve)) }
    },
    '../../utils/auth': { getCachedUser: () => user },
    '../../utils/events': events
  })[name]);
  const a = dashboard.overview();
  assert.equal(dashboard.overview(), a);
  calls[0]({ inventory: { count: 2 } });
  assert.equal((await a).inventory.count, 2);
  await dashboard.overview();
  assert.equal(calls.length, 1);

  const refresh = dashboard.overview({ refresh: true });
  calls[1]({ inventory: { count: 3 } });
  assert.equal((await refresh).inventory.count, 3);
  events.emit('business:changed');
  const old = dashboard.overview();

  user = { id: 'sales' };
  events.emit('auth:changed', user);
  const current = dashboard.overview();
  calls[2]({ inventory: { cost: 100 } });
  calls[3]({ inventory: { count: 3 } });
  await assert.rejects(old, /登录状态已更新/);
  assert.equal((await current).inventory.cost, undefined);
  assert.equal(calls.length, 4);
});

test('报表切换维度只查询拆分，重复点击与过期响应不会覆盖当前结果', async () => {
  let page;
  const calls = [];
  load('packages/staff/stats/index.js', (name) => ({
    '../../../utils/page': { createPage: (definition) => { page = definition; } },
    '../../../api/index': {
      stats: { breakdown: (params) => new Promise((resolve) => calls.push({ params, resolve })) }
    },
    '../../../utils/confirm': {},
    '../../../utils/report-file': {},
    '../../../constants/roles': require('../miniprogram/constants/roles'),
    '../../../utils/permission': {},
    '../../../utils/router': {}
  })[name]);
  page.setData = (fields) => Object.assign(page.data, fields);
  const pick = (value) => page.onDimension({ currentTarget: { dataset: { value } } });
  await pick('model');
  const first = pick('staff');
  await pick('staff');
  const last = pick('store');
  assert.deepEqual(calls.map(({ params }) => params.dimension), ['staff', 'store']);
  calls[1].resolve({ list: ['门店'] });
  await last;
  calls[0].resolve({ list: ['员工'] });
  await first;
  assert.equal(page.data.dimension, 'store');
  assert.equal(page.data.breakdown[0], '门店');
});
