/** 只在服务端使用的 PG Storage API；路径来自数据库，不接收客户端 URL。 */
const { fail, secret, dataEnvironment } = require('./gateway');

const MAX_BYTES = 32 * 1024 * 1024;
const SINGLE_VERIFY_MAX = 5 * 1024 * 1024;
const CHUNK_BYTES = 4 * 1024 * 1024;

function origin() {
  return `https://${dataEnvironment()}.api.tcloudbasegateway.com`;
}

function objectPath(bucket, key) {
  return `${encodeURIComponent(bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

async function request(path, { method = 'GET', body, headers = {} } = {}) {
  return fetch(origin() + '/v1/storages/' + path, {
    method,
    body,
    headers: { Authorization: `Bearer ${secret('CLOUDBASE_API_KEY')}`, ...headers },
    signal: AbortSignal.timeout(Number(process.env.STORAGE_TIMEOUT_MS) || 12000),
  });
}

async function json(path, { method = 'POST', body = {}, headers = {} } = {}) {
  const r = await request(path, {
    method,
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', ...headers },
  });
  const data = await r.json();
  if (!r.ok) {
    console.error('[storage]', r.status, data.code);
    fail(503, '云存储暂不可用，请重试');
  }
  return data;
}

async function info(bucket, key) {
  const r = await request('object/info/' + objectPath(bucket, key));
  if (r.status === 404) {
    await r.body?.cancel();
    return null;
  }
  if (!r.ok) {
    await r.body?.cancel();
    fail(503, '读取云存储元信息失败');
  }
  return r.json();
}

async function copy(
  sourceBucket,
  sourceKey,
  destinationBucket,
  destinationKey,
  mime = 'application/octet-stream',
  { skipDestCheck = false, missingSourceStatus = 0 } = {}
) {
  if (!skipDestCheck && await info(destinationBucket, destinationKey)) return;
  const r = await request('object/copy', {
    method: 'POST',
    body: JSON.stringify({
      bucketId: sourceBucket,
      sourceKey,
      destinationBucket,
      destinationKey,
      copyMetadata: false,
      metadata: { contentType: mime, mimetype: mime, cacheControl: 'private,no-store' },
    }),
    headers: { 'Content-Type': 'application/json' },
  });
  let data = {};
  try {
    data = await r.json();
  } catch (_) {}
  if (r.ok) return;

  const hint = `${data.code || ''} ${data.error || ''} ${data.message || ''}`;
  if (r.status === 409 || /already exists|duplicate/i.test(hint)) return;
  if (missingSourceStatus && (r.status === 404 || /not found|no such key/i.test(hint))) {
    fail(missingSourceStatus, '文件尚未上传，请重试');
  }
  if (await info(destinationBucket, destinationKey)) return;
  if (missingSourceStatus && !(await info(sourceBucket, sourceKey))) {
    fail(missingSourceStatus, '文件尚未上传，请重试');
  }
  console.error('[storage]', r.status, data.code);
  fail(503, '云存储暂不可用，请重试');
}

async function readChunk(bucket, key, offset, total, maxBytes = CHUNK_BYTES) {
  const end = Math.min(offset + maxBytes, total) - 1;
  const r = await request('object/' + objectPath(bucket, key), {
    headers: { Range: `bytes=${offset}-${end}` },
  });
  if (r.status === 404) {
    await r.body?.cancel();
    fail(409, '校验对象不存在，请重试');
  }
  const expected = `bytes ${offset}-${end}/${total}`;
  if (!((r.status === 206 && r.headers.get('content-range') === expected) || (r.status === 200 && offset === 0 && total <= maxBytes))) {
    await r.body?.cancel();
    fail(400, '实际文件大小不符或存储不支持分段读取');
  }
  const reader = r.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > end - offset + 1) {
        await reader.cancel();
        fail(400, '实际文件大小不符');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  if (size !== end - offset + 1) fail(400, '文件分段不完整');
  return Buffer.concat(chunks, size);
}

async function signRead(storedName) {
  const m = /^([A-Za-z0-9_-]+)\/(.+)$/.exec(storedName || '');
  if (!m) fail(503, '该文件尚未迁移到云存储');
  const result = await json('object/sign/' + objectPath(m[1], m[2]), { body: { expiresIn: 300 } });
  if (!result.fullSignedURL && !result.signedURL) fail(503, '文件链接获取失败');
  return result.fullSignedURL || new URL(result.signedURL, origin()).href;
}

function thumbnailUrl(signedUrl) {
  const url = new URL(signedUrl);
  const rule = 'imageMogr2/thumbnail/360x360/format/webp/quality/60';
  url.search += (url.search ? '&' : '?') + rule;
  return url.href;
}

async function signUpload(id) {
  const result = await json('object/upload/sign/' + objectPath('xiamu-staging', id), {
    headers: { 'x-upsert': 'false' },
  });
  if (!result.fullURL && !result.url) fail(503, '上传链接获取失败');
  return result.fullURL || new URL(result.url, origin()).href;
}

async function removeTemporary(bucket, key) {
  const r = await request('object/' + objectPath(bucket, key), { method: 'DELETE' });
  await r.body?.cancel();
  if (!r.ok && r.status !== 404) console.warn('[storage] temporary cleanup deferred', r.status);
}

module.exports = {
  MAX_BYTES,
  SINGLE_VERIFY_MAX,
  CHUNK_BYTES,
  origin,
  objectPath,
  request,
  json,
  info,
  copy,
  readChunk,
  signRead,
  thumbnailUrl,
  signUpload,
  removeTemporary,
};
