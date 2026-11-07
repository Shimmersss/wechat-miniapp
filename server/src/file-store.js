/**
 * 文件存储：本地磁盘 或 腾讯云 COS。
 *
 * 设计要点：
 * - 两种后端都实现同一组接口（put/open/remove），上层 files.js 不关心存在哪。
 * - 配了 COS_BUCKET 且密钥齐全就走 COS，否则回退本地磁盘——
 *   这样开发机不用配 COS 也能跑，线上配了自动切换。
 * - COS 的对象键就是 `<scope>/<stored_name>`，和本地磁盘目录结构一致，
 *   以后想迁移只要把文件搬过去，数据库不用动。
 * - internal 文件永远不暴露 COS 公网地址，读取一律由后端签临时 URL。
 */
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

/** COS 配置是否可用 */
function cosReady(config) {
  const c = config.cos;
  return !!(c && c.bucket && c.region && c.secretId && c.secretKey);
}

/**
 * 本地磁盘实现。
 * 目录结构：<fileRoot>/<scope>/<storedName>
 */
function localStore(config) {
  const root = config.fileRoot;
  return {
    kind: "local",
    async init() {
      for (const name of ["staging", "public", "internal"])
        await fsp.mkdir(path.join(root, name), { recursive: true, mode: 0o700 });
    },
    /** 把临时文件移到最终位置 */
    async put(scope, storedName, tempPath) {
      const target = path.join(root, scope, storedName);
      await fsp.rename(tempPath, target);
      return target;
    },
    /** 返回一个可读流 */
    async open(scope, storedName) {
      return fs.createReadStream(path.join(root, scope, storedName));
    },
    async remove(scope, storedName) {
      await fsp.rm(path.join(root, scope, storedName), { force: true });
    },
    /** 本地存储不需要签名 URL，返回 null 表示由 files.js 走后端代理 */
    async signedUrl() {
      return null;
    },
  };
}

/**
 * 腾讯云 COS 实现。
 * 依赖 cos-nodejs-sdk-v5，按需 require，没装就报清晰错误。
 */
function cosStore(config) {
  const c = config.cos;
  let cos = null;
  const key = (scope, storedName) => `${scope}/${storedName}`;

  function client() {
    if (cos) return cos;
    let COS;
    try {
      COS = require("cos-nodejs-sdk-v5");
    } catch (e) {
      throw new Error(
        "缺少 cos-nodejs-sdk-v5，请先运行 npm install cos-nodejs-sdk-v5",
      );
    }
    cos = new COS({ SecretId: c.secretId, SecretKey: c.secretKey });
    return cos;
  }

  return {
    kind: "cos",
    async init() {
      // 触发一次 client 构造，尽早暴露 SDK 缺失或凭证错误
      client();
    },
    async put(scope, storedName, tempPath) {
      const body = await fsp.readFile(tempPath);
      await new Promise((resolve, reject) => {
        client().putObject(
          {
            Bucket: c.bucket,
            Region: c.region,
            Key: key(scope, storedName),
            Body: body,
            // 私有读：对象本身不公开，只能靠签名 URL 访问
            ACL: "private",
          },
          (err) => (err ? reject(err) : resolve()),
        );
      });
      // 上传成功后删掉本地临时文件
      await fsp.rm(tempPath, { force: true });
      return key(scope, storedName);
    },
    async open(scope, storedName) {
      // 拉取对象到内存再返回流；文件都是图片/短视频，单个体积受上传限制约束
      const body = await new Promise((resolve, reject) => {
        client().getObject(
          { Bucket: c.bucket, Region: c.region, Key: key(scope, storedName) },
          (err, data) => (err ? reject(err) : resolve(data.Body)),
        );
      });
      const { Readable } = require("node:stream");
      return Readable.from(body);
    },
    async remove(scope, storedName) {
      await new Promise((resolve) => {
        client().deleteObject(
          { Bucket: c.bucket, Region: c.region, Key: key(scope, storedName) },
          () => resolve(),
        );
      });
    },
    /**
     * COS 临时签名 URL。
     * 有效期由调用方决定：internal 走短时效，public 可以长一些。
     */
    async signedUrl(scope, storedName, expiresSeconds) {
      return new Promise((resolve, reject) => {
        client().getObjectUrl(
          {
            Bucket: c.bucket,
            Region: c.region,
            Key: key(scope, storedName),
            Sign: true,
            Expires: expiresSeconds,
          },
          (err, data) => (err ? reject(err) : resolve(data.Url)),
        );
      });
    },
  };
}

/** 按配置选一个实现 */
function createStore(config) {
  return cosReady(config) ? cosStore(config) : localStore(config);
}

module.exports = { createStore, cosReady };
