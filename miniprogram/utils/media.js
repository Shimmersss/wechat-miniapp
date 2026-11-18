const { upload } = require('./request');

const KB = 1024;
const MB = 1024 * KB;
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

async function pick({ purpose, count, allowVideo = false, onStatus = () => {} }) {
  const { tempFiles, type } = await invoke(wx.chooseMedia, {
    count, mediaType: allowVideo ? ['image', 'video'] : ['image'],
    sizeType: ['original'], maxDuration: 30, camera: 'back',
  });
  const files = [];
  for (const [index, item] of tempFiles.entries()) {
    onStatus('压缩中', index, tempFiles.length);
    const mediaType = (item.fileType || type) === 'video' ? 'video' : 'image';
    try {
      const original = {
        filePath: item.tempFilePath, mediaType, duration: item.duration, size: item.size || await stat(item.tempFilePath),
      };
      const file = mediaType === 'video' ? await compressVideo(original) : await compressImage(original, purpose);
      if (mediaType === 'image' && file.size > 5 * MB) {
        discard(file);
        throw new Error('图片过大，请选用 5MB 以内的图片');
      }
      if (mediaType === 'video' && item.thumbTempFilePath) {
        try {
          file.poster = await compressImage({ filePath: item.thumbTempFilePath, size: await stat(item.thumbTempFilePath), mediaType: 'image' }, 'unit_poster');
        } catch (error) {
          console.warn('[media] video poster unavailable', error.errMsg || error.message);
        }
      }
      files.push(file);
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
      let poster;
      for (;;) {
        onStatus('上传中', index, files.length);
        try {
          if (file.poster && !poster) poster = await send({ filePath: file.poster.filePath, scope, bizType: 'unit_poster', mediaType: 'image' });
          const result = await send({
            filePath: file.filePath, scope, bizType: purpose, mediaType: file.mediaType, posterId: poster?.fileId,
          });
          completed.push({ ...result, mediaType: file.mediaType, ...(poster ? { posterUrl: poster.url } : {}) });
          break;
        } catch (error) {
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

// 所有业务入口共享一个前台队列，避免多个页面同时把大文件读入内存。
let active = false;
async function pickAndUpload({ purpose, count, allowVideo, scope = 'internal' }) {
  if (active) throw new Error('请等当前文件上传完成');
  active = true;
  const onStatus = (status, index, total) =>
    wx.showLoading({ title: status + ' ' + (index + 1) + '/' + total, mask: true });
  try {
    wx.enableAlertBeforeUnload?.({ message: '还有文件未上传完成，确定离开？' });
    const files = await pick({ purpose, count, allowVideo, onStatus });
    return await uploadSequential(files, {
      purpose, scope, onStatus,
      async onFailure(message, retry, index) {
        wx.hideLoading();
        const result = await invoke(wx.showModal, {
          title: '第 ' + (index + 1) + ' 个文件未完成',
          content: message, showCancel: retry, confirmText: retry ? '重试' : '知道了', cancelText: '跳过',
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

module.exports = { pick, uploadSequential, pickAndUpload, purposeProfile };
