const { upload } = require('./request');

const KB = 1024;
const MB = 1024 * KB;
const IMAGE_CONCURRENCY = 3;
const VIDEO_TOO_LARGE = '视频过大，请缩短到 30 秒以内后重试';
const PROFILES = {
  unit: { edge: 1600, quality: 80, target: 400 * KB },
  appearance: { edge: 1600, quality: 75, target: 350 * KB },
  receipt: { edge: 2000, quality: 85, target: 800 * KB },
};

function purposeProfile(purpose) {
  if (purpose === 'unit' || purpose === 'unit_poster') return PROFILES.unit;
  if (purpose === 'repair_appearance' || purpose.startsWith('loan')) return PROFILES.appearance;
  return PROFILES.receipt;
}

/** 凭证需要保留清晰文字沿用原图；设备照与外观照先走微信客户端压缩。 */
function sizeTypeFor(purpose) {
  return purposeProfile(purpose) === PROFILES.receipt ? ['original'] : ['compressed'];
}

const invoke = (api, input) => new Promise((resolve, reject) => {
  api({ ...input, success: resolve, fail: reject });
});
const stat = async filePath => (await invoke(wx.getFileSystemManager().getFileInfo, { filePath })).size;

function canResizeImage() {
  const [major, minor] = (wx.getAppBaseInfo?.().SDKVersion || '').split('.').map(Number);
  return major > 2 || major === 2 && minor >= 26;
}

async function jpegFromPng(src, width, height, quality) {
  const canvas = wx.createOffscreenCanvas({ type: '2d', width, height });
  const image = canvas.createImage();
  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = reject;
    image.src = src;
  });
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(image, 0, 0, width, height);
  const dataUrl = canvas.toDataURL('image/jpeg', quality / 100);
  if (!dataUrl.startsWith('data:image/jpeg;base64,')) throw new Error('JPEG 转换失败');
  const filePath = wx.env.USER_DATA_PATH + '/media-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.jpg';
  await invoke(wx.getFileSystemManager().writeFile, { filePath, data: dataUrl.split(',')[1], encoding: 'base64' });
  return { filePath, managed: true };
}

function discard(file) {
  if (file?.managed) wx.getFileSystemManager().unlink({
    filePath: file.filePath,
    fail: error => console.warn('[media] failed to remove temporary JPEG', error.errMsg),
  });
}

async function compressImage(original, purpose) {
  const profile = purposeProfile(purpose);
  let best = original;
  let candidate;
  try {
    const info = await invoke(wx.getImageInfo, { src: original.filePath });
    const convert = String(info.type).toLowerCase() === 'png';
    const factor = Math.min(1, profile.edge / Math.max(info.width, info.height));
    if (!convert && factor === 1 && original.size <= profile.target) return original;
    const width = Math.max(1, Math.round(info.width * factor));
    const height = Math.max(1, Math.round(info.height * factor));
    for (const quality of [profile.quality, profile.quality - 15]) {
      candidate = convert
        ? await jpegFromPng(original.filePath, width, height, quality)
        : { filePath: (await invoke(wx.compressImage, {
          src: original.filePath, quality, ...(factor < 1 && canResizeImage() ? { compressedWidth: width } : {}),
        })).tempFilePath };
      candidate.size = await stat(candidate.filePath);
      if (candidate.size && (candidate.size < best.size || convert && best === original && candidate.size <= 5 * MB)) {
        discard(best);
        best = { ...original, ...candidate };
      } else {
        discard(candidate);
      }
      candidate = null;
      if (best.size <= profile.target * 1.5) break;
    }
  } catch (error) {
    discard(candidate);
    console.warn('[media] image compression unavailable', error.errMsg || error.message);
  }
  return best;
}

const isMp4 = value => /^(video\/)?mp4$/i.test(String(value || ''));
const extension = filePath => String(filePath || '').split('?')[0].split('.').pop();

async function compressVideo(original) {
  const info = await invoke(wx.getVideoInfo, { src: original.filePath }).catch(() => null);
  if (Number(info?.duration || original.duration) > 30) throw new Error('视频最长 30 秒，请剪短后重试');
  // iPhone 相册视频常为 MOV，服务端按内容只收 MP4；微信压缩输出 MP4，因此非 MP4 必须压缩成功才能上传。
  const originalMp4 = isMp4(info?.type || extension(original.filePath));
  let best = originalMp4 ? original : null;
  try {
    const { tempFilePath } = await invoke(wx.compressVideo, { src: original.filePath, quality: 'medium' });
    const size = await stat(tempFilePath);
    const outputMp4 = isMp4(extension(tempFilePath));
    if (size && outputMp4 && (!best || size < best.size)) best = { ...original, filePath: tempFilePath, size };
  } catch (error) {
    console.warn('[media] video compression unavailable', error.errMsg || error.message);
  }
  if (!best) throw new Error('该视频无法转为 MP4，请直接拍摄或换一段视频');
  if (best.size > 20 * MB) throw new Error(VIDEO_TOO_LARGE);
  return best;
}

async function prepareFile(item, mediaType, purpose) {
  const original = {
    filePath: item.tempFilePath,
    mediaType,
    duration: item.duration,
    size: item.size || await stat(item.tempFilePath),
  };
  const file = mediaType === 'video' ? await compressVideo(original) : await compressImage(original, purpose);
  if (mediaType === 'image' && file.size > 5 * MB) {
    discard(file);
    throw new Error('图片过大，请选用 5MB 以内的图片');
  }
  if (mediaType === 'video' && item.thumbTempFilePath) {
    try {
      file.poster = await compressImage(
        { filePath: item.thumbTempFilePath, size: await stat(item.thumbTempFilePath), mediaType: 'image' },
        'unit_poster'
      );
    } catch (error) {
      console.warn('[media] video poster unavailable', error.errMsg || error.message);
    }
  }
  return file;
}

async function uploadPrepared(file, { scope, purpose, send, cachedPoster }) {
  let poster = cachedPoster || null;
  if (file.poster && !poster) {
    poster = await send({
      filePath: file.poster.filePath,
      size: file.poster.size,
      scope,
      bizType: 'unit_poster',
      mediaType: 'image',
    });
  }
  try {
    const result = await send({
      filePath: file.filePath,
      size: file.size,
      scope,
      bizType: purpose,
      mediaType: file.mediaType,
      posterId: poster?.fileId,
    });
    return {
      poster,
      uploaded: { ...result, mediaType: file.mediaType, ...(poster ? { posterUrl: poster.url } : {}) },
    };
  } catch (error) {
    error._poster = poster;
    throw error;
  }
}

async function pick({ purpose, count, allowVideo = false, onStatus = () => {} }) {
  const { tempFiles, type } = await invoke(wx.chooseMedia, {
    count,
    mediaType: allowVideo ? ['image', 'video'] : ['image'],
    sizeType: sizeTypeFor(purpose),
    maxDuration: 30,
    camera: 'back',
  });
  const files = [];
  for (const [index, item] of tempFiles.entries()) {
    onStatus('压缩中', index, tempFiles.length);
    const mediaType = (item.fileType || type) === 'video' ? 'video' : 'image';
    try {
      files.push(await prepareFile(item, mediaType, purpose));
    } catch (error) {
      files.push({ error: error.message || '无法读取选中的文件' });
    }
  }
  return files;
}

async function uploadSequential(files, { scope, purpose, onStatus = () => {}, onFailure = async () => false, send = upload }) {
  const completed = [];
  for (const [index, file] of files.entries()) {
    try {
      if (file.error) {
        await onFailure(file.error, false, index);
        continue;
      }
      let poster = null;
      for (;;) {
        onStatus('上传中', index, files.length);
        try {
          const out = await uploadPrepared(file, { scope, purpose, send, cachedPoster: poster });
          poster = out.poster;
          completed.push(out.uploaded);
          break;
        } catch (error) {
          poster = error?._poster || poster;
          if (!await onFailure(error.message || '上传未完成，请重试', true, index)) break;
        }
      }
    } finally {
      discard(file);
      discard(file.poster);
    }
  }
  return completed;
}

/**
 * 压缩并上传并发流水线：
 * - 图片在有界并发池（默认 3 路）中逐张“压缩完即上传”，按原选择顺序输出；
 * - 视频放在图片之后串行处理（并发 1），避免同时把 20MB 大视频读入内存；
 * - 任一项失败不阻塞其余文件，也不弹窗堆叠，全部结束后按序号逐个提示重试/跳过，并在 finally 清理临时文件。
 */
async function processAndUpload(
  rawItems,
  { scope, purpose, concurrency = IMAGE_CONCURRENCY, onProgress = () => {}, onFailure = async () => false, send = upload }
) {
  const items = (Array.isArray(rawItems) ? rawItems : []).map((item, index) => ({
    ...item,
    index,
    mediaType: item.mediaType === 'video' ? 'video' : 'image',
  }));
  const total = items.length;
  if (!total) return [];

  const results = new Array(total);
  const failures = [];
  let doneCount = 0;

  async function runOne(item) {
    let file = null;
    try {
      file = await prepareFile(item, item.mediaType, purpose);
      const out = await uploadPrepared(file, { scope, purpose, send });
      results[item.index] = out.uploaded;
      doneCount += 1;
      onProgress(doneCount, total, item.index);
      discard(file);
      discard(file.poster);
    } catch (error) {
      failures.push({
        index: item.index,
        file,
        poster: error?._poster || null,
        message: error?.message || (file ? '上传未完成，请重试' : '无法读取选中的文件'),
        retryable: !!file && Number(error?.code) !== 401,
      });
    }
  }

  const imageItems = items.filter((item) => item.mediaType !== 'video');
  const videoItems = items.filter((item) => item.mediaType === 'video');
  const workerCount = Math.min(Math.max(1, concurrency), imageItems.length);
  let cursor = 0;

  async function worker() {
    while (cursor < imageItems.length) {
      const next = imageItems[cursor++];
      await runOne(next);
    }
  }

  if (workerCount > 0) {
    await Promise.all(Array.from({ length: workerCount }, worker));
  }
  for (const videoItem of videoItems) {
    await runOne(videoItem);
  }

  failures.sort((a, b) => a.index - b.index);
  for (const entry of failures) {
    try {
      let message = entry.message;
      let retryable = entry.retryable;
      let poster = entry.poster;
      for (;;) {
        const retry = await onFailure(message, retryable, entry.index);
        if (!retry || !retryable) break;
        onProgress(doneCount, total, entry.index);
        try {
          const out = await uploadPrepared(entry.file, { scope, purpose, send, cachedPoster: poster });
          poster = out.poster;
          results[entry.index] = out.uploaded;
          doneCount += 1;
          onProgress(doneCount, total, entry.index);
          break;
        } catch (err) {
          poster = err?._poster || poster;
          message = err?.message || '上传未完成，请重试';
          retryable = Number(err?.code) !== 401;
        }
      }
    } finally {
      discard(entry.file);
      discard(entry.file?.poster);
    }
  }

  return results.filter(Boolean);
}

// 所有业务入口共享一个前台队列，避免多个页面同时把大量媒体读入内存。
let active = false;
async function pickAndUpload({ purpose, count, allowVideo = false, scope = 'internal' }) {
  if (active) throw new Error('请等当前文件上传完成');
  active = true;
  const onProgress = (done, total) => wx.showLoading({
    title: total > 1 ? '上传中 ' + done + '/' + total : '上传中',
    mask: true,
  });
  try {
    wx.enableAlertBeforeUnload?.({ message: '还有文件未上传完成，确定离开？' });
    const { tempFiles, type } = await invoke(wx.chooseMedia, {
      count,
      mediaType: allowVideo ? ['image', 'video'] : ['image'],
      sizeType: sizeTypeFor(purpose),
      maxDuration: 30,
      camera: 'back',
    });
    if (!tempFiles?.length) return [];
    const rawItems = tempFiles.map((item) => ({
      ...item,
      mediaType: (item.fileType || type) === 'video' ? 'video' : 'image',
    }));
    onProgress(0, rawItems.length);
    return await processAndUpload(rawItems, {
      purpose,
      scope,
      onProgress,
      async onFailure(message, retry, index) {
        wx.hideLoading();
        const result = await invoke(wx.showModal, {
          title: '第 ' + (index + 1) + ' 个文件未完成',
          content: message,
          showCancel: retry,
          confirmText: retry ? '重试' : '知道了',
          cancelText: '跳过',
        }).catch(() => ({}));
        return retry && result.confirm;
      },
    });
  } finally {
    wx.hideLoading();
    wx.disableAlertBeforeUnload?.();
    active = false;
  }
}

module.exports = {
  IMAGE_CONCURRENCY,
  sizeTypeFor,
  pick,
  uploadSequential,
  processAndUpload,
  pickAndUpload,
  purposeProfile,
};
