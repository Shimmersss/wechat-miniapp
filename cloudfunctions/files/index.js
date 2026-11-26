const crypto = require('node:crypto');
const { createHandler, rpc, fail, HttpError } = require('./shared/gateway');
const { currentUser, requireUser } = require('./shared/identity');
const storage = require('./shared/pg-storage');
const { createSHA256 } = require('hash-wasm');

function uuid(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) {
    fail(400, '文件标识无效');
  }
  return value;
}

async function fileView(f) {
  const [url, posterRow] = await Promise.all([
    storage.signRead(f.stored_name),
    f.poster_id ? rpc('api_file_read', { p_id: f.poster_id, p_user: null }) : Promise.resolve(null),
  ]);
  const posterUrl = posterRow ? await storage.signRead(posterRow.stored_name) : undefined;
  return {
    fileId: f.id,
    scope: f.scope,
    mime: f.mime,
    size: Number(f.byte_size),
    url,
    ...(f.mime && f.mime.startsWith('image/') ? { thumbUrl: storage.thumbnailUrl(url) } : {}),
    ...(posterUrl ? { posterUrl } : {}),
  };
}

async function uploadRpc(ctx, user, action, id, data = {}) {
  return rpc('api_file_upload', {
    p_action: action,
    p_id: id,
    p_data: data,
    p_user: user,
    p_request_id: ctx.requestId,
  });
}

async function detectAndValidateMime(bytes, upload) {
  const { fileTypeFromBuffer } = await import('file-type');
  let type;
  try {
    type = await fileTypeFromBuffer(bytes);
  } catch (e) {
    if (e.name === 'EndOfStreamError') fail(400, '文件内容不完整');
    throw e;
  }
  if (!type || !['image/jpeg', 'image/png', 'image/webp', 'video/mp4'].includes(type.mime)) {
    fail(400, '仅支持 JPEG、PNG、WebP 或 MP4');
  }
  const mime = type.mime;
  if (upload.scope === 'internal' && mime === 'video/mp4') fail(400, '内部凭证请上传图片');
  if (upload.expected_size > (mime === 'video/mp4' ? 25 : 5) * 1024 * 1024) {
    fail(413, '文件大小超出上传限制');
  }
  if (upload.media_kind && (upload.media_kind === 'video') !== (mime === 'video/mp4')) {
    fail(400, '文件内容与选择的类型不一致');
  }
  return mime;
}

async function finalizeCleanupAndView(file, stagingId, sealedKey) {
  const [view, ...cleanup] = await Promise.allSettled([
    fileView(file),
    storage.removeTemporary('xiamu-staging', stagingId),
    storage.removeTemporary('xiamu-sealed', sealedKey),
  ]);
  if (cleanup.some((r) => r.status === 'rejected')) console.warn('[storage] temporary cleanup deferred');
  if (view.status === 'rejected') throw view.reason;
  return view.value;
}

async function intent(ctx) {
  const user = await requireUser(ctx);
  const d = ctx.data;
  if (!Number.isInteger(d.size) || d.size < 1 || d.size > storage.MAX_BYTES) {
    fail(d.size > storage.MAX_BYTES ? 413 : 400, '文件须为1～32MB');
  }
  const result = await uploadRpc(ctx, user, 'intent', null, d);
  if (result.file) return { file: await fileView(result.file) };
  if (result.upload.status === 'failed' || Date.parse(result.upload.expires_at) <= Date.now()) {
    fail(409, '上传已失效，请重试');
  }
  return { uploadId: result.upload.id, uploadUrl: await storage.signUpload(result.upload.id), method: 'PUT' };
}

async function complete(ctx) {
  const user = await requireUser(ctx);
  const id = uuid(ctx.params.id);
  const state = await uploadRpc(ctx, user, 'begin', id);
  if (state.file) return fileView(await rpc('api_file_read', { p_id: id, p_user: user }));
  let upload = state.upload;
  const lease = upload.lease;
  const progress = (data) => rpc('api_file_progress', { p_id: id, p_lease: lease, p_data: data, p_user: user });

  try {
    // <= 5MB 单次直核路径：省去 seal / chunk 两次中间进度 RPC 与 512KB 多轮分片请求。
    if (!upload.sealed_key && upload.verified_bytes === 0 && upload.expected_size <= storage.SINGLE_VERIFY_MAX) {
      const sealedKey = id + '-' + lease;
      await storage.copy('xiamu-staging', id, 'xiamu-sealed', sealedKey, 'application/octet-stream', {
        skipDestCheck: true,
        missingSourceStatus: 409,
      });
      const bytes = await storage.readChunk('xiamu-sealed', sealedKey, 0, upload.expected_size, storage.SINGLE_VERIFY_MAX);
      const mime = await detectAndValidateMime(bytes, upload);
      const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      await storage.copy('xiamu-sealed', sealedKey, 'xiamu-' + upload.scope, sealedKey, mime, {
        skipDestCheck: true,
      });
      const result = await uploadRpc(ctx, user, 'commit_sealed', id, {
        lease,
        sealedKey,
        mime,
        size: upload.expected_size,
        sha256,
      });
      return await finalizeCleanupAndView(result.file, id, sealedKey);
    }

    // 校验区每次用新的租约编号生成对象名；大视频继续按 4MB 分段核验。
    if (!upload.sealed_key) {
      const sealedKey = id + '-' + lease;
      await storage.copy('xiamu-staging', id, 'xiamu-sealed', sealedKey, 'application/octet-stream', {
        skipDestCheck: true,
        missingSourceStatus: 409,
      });
      upload = await progress({ stage: 'seal', sealedKey });
    }
    if (upload.verified_bytes < upload.expected_size) {
      const bytes = await storage.readChunk(
        'xiamu-sealed',
        upload.sealed_key,
        upload.verified_bytes,
        upload.expected_size,
        storage.CHUNK_BYTES
      );
      const mime = upload.verified_bytes === 0 ? await detectAndValidateMime(bytes, upload) : upload.detected_mime;
      const hasher = await createSHA256();
      if (upload.hash_state) hasher.load(Buffer.from(upload.hash_state, 'base64'));
      else hasher.init();
      hasher.update(bytes);
      const next = upload.verified_bytes + bytes.length;
      const done = next === upload.expected_size;
      const hashState = Buffer.from(hasher.save()).toString('base64');
      const sha256 = done ? hasher.digest('hex') : undefined;
      upload = await progress({ stage: 'chunk', from: upload.verified_bytes, offset: next, hashState, mime, sha256 });
      if (!done) return { processing: true, uploadId: id, processedBytes: next, totalBytes: upload.expected_size };
    }
    await storage.copy('xiamu-sealed', upload.sealed_key, 'xiamu-' + upload.scope, upload.sealed_key, upload.detected_mime, {
      skipDestCheck: true,
    });
    const result = await uploadRpc(ctx, user, 'commit', id, {
      lease,
      mime: upload.detected_mime,
      size: upload.expected_size,
      sha256: upload.verified_sha,
    });
    return await finalizeCleanupAndView(result.file, id, upload.sealed_key);
  } catch (e) {
    try {
      await uploadRpc(ctx, user, 'fail', id, {
        lease,
        permanent: e instanceof HttpError && [400, 413].includes(e.statusCode),
        message: e instanceof HttpError ? e.message : '核验中断，请重试',
      });
    } catch (stateError) {
      console.error('[upload] state update failed', id, stateError.name);
    }
    throw e;
  }
}

exports.main = createHandler([
  ['POST', '/files/upload-intent', intent],
  ['POST', '/files/:id/complete', complete],
  ['GET', '/files/:id', async (ctx) => fileView(await rpc('api_file_read', { p_id: uuid(ctx.params.id), p_user: await currentUser(ctx) }))],
]);
