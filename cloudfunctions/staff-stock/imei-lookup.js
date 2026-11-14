const { rpc } = require('./shared/gateway');

const manual = '请手动选择型号';

function nameKey(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[\s._-]+/g, '');
}

function brandKey(value) {
  const brand = nameKey(value);
  const aliases = {
    苹果: 'apple', 华为: 'huawei', 小米: 'xiaomi', 荣耀: 'honor', 三星: 'samsung',
    一加: 'oneplus', 红米: 'redmi', 真我: 'realme', 魅族: 'meizu',
  };
  return Object.hasOwn(aliases, brand) ? aliases[brand] : brand;
}

function catalogModel(models, candidate) {
  const brand = brandKey(candidate.brand);
  const name = nameKey(candidate.name);
  const matches = models.filter(model =>
    nameKey(model.name) === name &&
    [model.brand, model.brandLabel].some(value => brandKey(value) === brand));
  return matches.length === 1 ? matches[0] : undefined;
}

async function lookup51gcc(imei, apiKey, fetcher) {
  const response = await fetcher('https://open-api.51gcc.com', {
    method: 'POST',
    body: new URLSearchParams({ sn: imei, api_id: '1', api_test: '0', api_key: apiKey }),
    signal: AbortSignal.timeout(1800),
    redirect: 'error',
  });
  if (!response.ok) return null;
  const result = await response.json();
  if (result.code !== 200 || !Array.isArray(result.data?.result)) return null;
  const read = key => {
    const values = result.data.result.filter(field => field?.key === key);
    const value = values.length === 1 ? values[0].value : null;
    return typeof value === 'string' && !/\d{15}/.test(value) ? value.trim().slice(0, 100) : '';
  };
  const brand = read('manufacturer');
  const name = read('model');
  return brand && name ? { brand, name, networkModel: read('product') } : null;
}

async function identifyWithFallback({ data, user, requestId }, {
  env = process.env, fetcher = fetch, call = rpc,
} = {}) {
  const imei = data.imei;
  const local = await call('api_imei_model_lookup', { p_imei: imei });
  if (local.matched || local.candidate) return local;
  const apiKey = env.IMEI_51GCC_API_KEY?.trim();
  if (data.allowPaidLookup !== true ||
    env.IMEI_PAID_LOOKUP_ENABLED !== '1' || !apiKey) return local;

  const limit = Number(env.IMEI_PAID_LOOKUP_DAILY_LIMIT || '20');
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) return local;

  try {
    const reserved = await call('api_imei_paid_lookup_reserve', {
      p_imei: imei, p_daily_limit: limit,
    });
    if (reserved !== true) return local;
    const candidate = await lookup51gcc(imei, apiKey, fetcher);
    if (!candidate) return local;
    const models = await call('api_stock', {
      p_action: 'models.list', p_params: {}, p_data: {},
      p_user: { id: user.id, permissions: [] }, p_request_id: requestId,
    });
    const model = catalogModel(models, candidate);
    return {
      matched: false,
      candidate: { ...candidate, source: '果查查', ...(model ? { model } : {}) },
      message: model
        ? '第三方返回候选型号，请核对实机；容量、颜色与机况需另行填写'
        : `第三方识别为 ${candidate.brand} ${candidate.name}，${manual}`,
    };
  } catch {
    // 查询失败仍可入库。异常可能包含外部请求详情，不把它写进日志或响应。
    return local;
  }
}

module.exports = { identifyWithFallback };
