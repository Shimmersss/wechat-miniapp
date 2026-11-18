const test = require('node:test');
const assert = require('node:assert/strict');
const { pick, purposeProfile, uploadSequential } = require('../miniprogram/utils/media');

const kb = 1024, mb = 1024 * kb;
const success = value => ({ success }) => success(value);
const failure = ({ fail }) => fail({ errMsg: 'unsupported' });

function mock(file, overrides) {
  global.wx = {
    chooseMedia: success({ tempFiles: [file] }),
    getImageInfo: success({ width: 600, height: 400, type: 'jpeg' }),
    getAppBaseInfo: () => ({ SDKVersion: '2.28.0' }),
    ...overrides,
  };
}

test('按用途选择图片档位，小图跳过压缩', async () => {
  assert.deepEqual(purposeProfile('unit'), { edge: 1600, quality: 80, target: 400 * kb });
  assert.deepEqual(purposeProfile('loan_return'), { edge: 1600, quality: 75, target: 350 * kb });
  assert.deepEqual(purposeProfile('sales_receipt'), { edge: 2000, quality: 85, target: 800 * kb });
  mock({ tempFilePath: 'small.jpg', size: 10 * kb }, { compressImage: () => assert.fail('无需压缩') });
  assert.equal((await pick({ count: 1, purpose: 'unit' }))[0].filePath, 'small.jpg');
});

test('最长边按比例缩放，只额外降质一次', async () => {
  const qualities = [];
  mock({ tempFilePath: 'camera.jpg', size: 2 * mb }, {
    getImageInfo: success({ width: 2000, height: 4000, type: 'jpeg' }),
    compressImage: ({ quality, compressedWidth, success }) => {
      assert.equal(compressedWidth, 800);
      qualities.push(quality);
      success({ tempFilePath: 'q' + quality });
    },
    getFileSystemManager: () => ({ getFileInfo: ({ filePath, success }) => success({ size: filePath === 'q80' ? 800 * kb : 500 * kb }) }),
  });
  assert.equal((await pick({ count: 1, purpose: 'unit' }))[0].filePath, 'q65');
  assert.deepEqual(qualities, [80, 65]);
});

test('压缩失败时回退原图；过大的原视频给出提示', async () => {
  mock({ tempFilePath: 'camera.jpg', size: mb }, { compressImage: failure });
  assert.equal((await pick({ count: 1, purpose: 'receipt' }))[0].filePath, 'camera.jpg');
  mock({ tempFilePath: 'camera.mp4', size: 21 * mb, fileType: 'video' }, {
    getVideoInfo: success({ duration: 30 }), compressVideo: failure,
  });
  assert.match((await pick({ count: 1, purpose: 'unit', allowVideo: true }))[0].error, /视频过大.*30 秒/);
});

test('依次上传，单个文件重试失败后仍保留前后成功项', async () => {
  const messages = [], seen = [];
  let active = 0;
  const sequence = ['a', 'b', 'c'].map(filePath => ({ filePath, mediaType: 'image' }));
  const results = await uploadSequential(sequence, {
    scope: 'internal', purpose: 'sales_receipt',
    async send({ filePath }) {
      assert.equal(++active, 1);
      seen.push(filePath);
      await Promise.resolve();
      active--;
      if (filePath === 'b') throw new Error('上传未完成，请重试');
      return { fileId: filePath };
    },
    async onFailure(message, retry) {
      assert.ok(retry);
      messages.push(message);
      return messages.length === 1;
    },
  });
  assert.deepEqual(seen, ['a', 'b', 'b', 'c']);
  assert.deepEqual(results.map(f => f.fileId), ['a', 'c']);
});

test('视频重试复用已经上传成功的封面并传回可访问 URL', async () => {
  const attempts = [];
  const [file] = await uploadSequential([{ filePath: 'camera.mp4', mediaType: 'video', poster: { filePath: 'cover.jpg' } }], {
    scope: 'public', purpose: 'unit',
    async send(data) {
      attempts.push(data);
      if (data.bizType === 'unit_poster') return { fileId: 'poster-id', url: 'cover-url' };
      assert.equal(data.posterId, 'poster-id');
      if (attempts.length === 2) throw new Error('retry');
      return { fileId: 'video-id' };
    },
    onFailure: async () => true,
  });
  assert.equal(attempts.filter(entry => entry.bizType === 'unit_poster').length, 1);
  assert.deepEqual(file, { fileId: 'video-id', mediaType: 'video', posterUrl: 'cover-url' });
});
