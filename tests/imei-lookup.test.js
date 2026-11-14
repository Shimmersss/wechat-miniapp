const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');

const moduleExports = { exports: {} };
runInNewContext(readFileSync(require.resolve('../cloudfunctions/staff-stock/imei-lookup'), 'utf8'), {
  module: moduleExports,
  require(name) {
    assert.equal(name, './shared/gateway');
    return {};
  },
  process, fetch, URLSearchParams, AbortSignal,
});
const { identifyWithFallback } = moduleExports.exports;
const imei = '490154203237518';
const miss = { matched: false, message: '请手动选择型号' };
const model = { id: 'model', name: 'iPhone 16 Pro', brandLabel: '苹果' };
const env = { IMEI_PAID_LOOKUP_ENABLED: '1', IMEI_51GCC_API_KEY: 'test-secret', IMEI_PAID_LOOKUP_DAILY_LIMIT: '7' };

function lookup({ local = miss, allowPaidLookup = true, config = env, reserved = true, models = [model], response } = {}) {
  const calls = [], requests = [];
  const done = identifyWithFallback({ data: { imei, allowPaidLookup }, user: { id: 'staff' } }, {
    env: config,
    async call(name, params) {
      calls.push(name);
      if (name === 'api_imei_model_lookup') return local;
      if (name === 'api_imei_paid_lookup_reserve') {
        assert.equal(params.p_imei, imei);
        assert.equal(params.p_daily_limit, 7);
        return reserved;
      }
      assert.equal(name, 'api_stock');
      assert.equal(params.p_action, 'models.list');
      return models;
    },
    async fetcher(url, options) {
      requests.push({ url, options });
      if (response instanceof Error) throw response;
      return {
        ok: true,
        json: async () => response || { code: 200, data: { result: [
          { key: 'imei', value: imei },
          { key: 'manufacturer', value: 'Apple' },
          { key: 'model', value: 'iPhone 16 Pro' },
          { key: 'product', value: 'A3294' },
        ] } },
      };
    },
  });
  return { done, calls, requests };
}

test('店内和开放库命中、付费开关关闭、缺密钥、自动复核和额度用尽均不请求上游', async () => {
  for (const options of [
    { local: { matched: true, model } },
    { local: { matched: false, candidate: { model } } },
    { config: { ...env, IMEI_PAID_LOOKUP_ENABLED: '0' } },
    { config: { ...env, IMEI_51GCC_API_KEY: '' } },
    { allowPaidLookup: false },
    { reserved: false },
  ]) {
    const attempt = lookup(options);
    assert.equal(await attempt.done, options.local || miss);
    assert.equal(attempt.requests.length, 0);
  }
});

test('付费查询只返回候选，核对品牌与型号，并裁掉原始 IMEI', async () => {
  const attempt = lookup();
  const view = await attempt.done;
  assert.deepEqual(attempt.calls, ['api_imei_model_lookup', 'api_imei_paid_lookup_reserve', 'api_stock']);
  assert.equal(attempt.requests[0].url, 'https://open-api.51gcc.com');
  assert.equal(attempt.requests[0].options.body.get('api_test'), '0');
  assert.equal(attempt.requests[0].options.body.get('sn'), imei);
  assert.equal(view.matched, false);
  assert.equal(view.candidate.model.id, model.id);
  assert.equal(JSON.stringify(view).includes(imei), false);
  assert.equal(JSON.stringify(view).includes(env.IMEI_51GCC_API_KEY), false);
  const ambiguous = await lookup({ models: [model, { ...model, id: 'other' }] }).done;
  assert.equal(ambiguous.candidate.model, undefined);
});

test('第三方超时或业务错误时保留手动选择入口', async () => {
  assert.equal(await lookup({ response: Error('timeout') }).done, miss);
  assert.equal(await lookup({ response: { code: 600 } }).done, miss);
});
