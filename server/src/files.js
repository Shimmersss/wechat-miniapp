const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { pipeline } = require("node:stream/promises");
const { Transform } = require("node:stream");
const { one, transaction } = require("./db");
const {
  PERM,
  fail,
  id,
  hmac,
  equal,
  requirePerm,
  loadUser,
  audit,
} = require("./core");
const permissions = [PERM.INBOUND, PERM.ACCEPTANCE, PERM.PURCHASE_MANAGE];
const { canReadInternal } = require("./repair-files");
function signFile(config, fileId, sessionHash) {
  const expires = Math.floor(Date.now() / 1000) + 300;
  const signature = hmac(config.fileKey, `${fileId}:${expires}:${sessionHash}`);
  return `${config.publicOrigin}/api/v1/files/${fileId}/content?expires=${expires}&sid=${sessionHash}&signature=${signature}`;
}
module.exports = async function files(app, { pool, config, route }) {
  const root = config.fileRoot;
  for (const name of ["staging", "public", "internal"])
    await fsp.mkdir(path.join(root, name), { recursive: true, mode: 0o700 });
  function view(file, request) {
    return {
      fileId: file.id,
      scope: file.scope,
      mime: file.mime,
      size: Number(file.byte_size),
      url:
        file.scope === "public"
          ? `${config.publicOrigin}/api/v1/files/${file.id}/content`
          : signFile(config, file.id, request.sessionHash),
    };
  }
  route(
    "POST",
    "/files",
    async (request) => {
      requirePerm(
        request,
        ...permissions,
        PERM.REPAIR_HANDLE,
        PERM.REPAIR_CASH,
        PERM.LOAN_MANAGE,
        PERM.SALES_CREATE,
        PERM.REFUND,
      );
      let tempPath,
        scope,
        type,
        fileId,
        storedName,
        size = 0,
        digest;
      try {
        for await (const part of request.parts()) {
          if (part.type !== "file") {
            if (part.fieldname === "scope") scope = part.value;
            continue;
          }
          if (tempPath || part.fieldname !== "file")
            fail(400, "只允许上传一个文件");
          fileId = id();
          tempPath = path.join(root, "staging", fileId);
          const hash = crypto.createHash("sha256");
          const counter = new Transform({
            transform(chunk, encoding, callback) {
              size += chunk.length;
              hash.update(chunk);
              callback(null, chunk);
            },
          });
          await pipeline(
            part.file,
            counter,
            fs.createWriteStream(tempPath, { flags: "wx", mode: 0o600 }),
          );
          if (part.file.truncated) fail(413, "文件超过允许大小");
          digest = hash.digest("hex");
        }
        if (!tempPath || !["public", "internal"].includes(scope))
          fail(400, "请上传文件并指定 public/internal 范围");
        if (scope === "public") requirePerm(request, ...permissions);
        if (scope === "internal")
          requirePerm(
            request,
            ...permissions,
            PERM.REPAIR_HANDLE,
            PERM.REPAIR_CASH,
            PERM.LOAN_MANAGE,
            // 销售收款凭证
            PERM.SALES_CREATE,
            PERM.REFUND,
          );
        const { fileTypeFromFile } = await import("file-type");
        try {
          type = await fileTypeFromFile(tempPath);
        } catch (error) {
          if (error.name === "EndOfStreamError") fail(400, "文件内容不完整");
          throw error;
        }
        if (
          !type ||
          !["image/jpeg", "image/png", "image/webp", "video/mp4"].includes(
            type.mime,
          )
        )
          fail(400, "仅支持 JPEG、PNG、WebP 或 MP4");
        if (scope === "internal" && type.mime === "video/mp4")
          fail(400, "收货凭证请上传图片");
        storedName = fileId + "." + type.ext;
        const target = path.join(root, scope, storedName);
        await fsp.rename(tempPath, target);
        tempPath = target;
        const file = {
          id: fileId,
          scope,
          stored_name: storedName,
          mime: type.mime,
          byte_size: size,
          owner_id: request.user.id,
        };
        await transaction(pool, async (db) => {
          await db.execute(
            "INSERT INTO files (id,scope,stored_name,mime,byte_size,sha256,owner_id) VALUES (?,?,?,?,?,?,?)",
            [
              file.id,
              scope,
              storedName,
              type.mime,
              size,
              digest,
              request.user.id,
            ],
          );
          await audit(db, request, "上传文件", fileId, {
            after: { scope, mime: type.mime, size },
          });
        });
        tempPath = null;
        return view(file, request);
      } finally {
        if (tempPath) await fsp.unlink(tempPath).catch(() => {});
      }
    },
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
  );
  route("GET", "/files/:id", async (request) => {
    const file = await one(pool, "SELECT * FROM files WHERE id=?", [
      request.params.id,
    ]);
    if (!file) fail(404, "文件不存在");
    if (
      file.scope === "internal" &&
      !(await canReadInternal(pool, file, request.user))
    )
      fail(request.user ? 403 : 401, "无权限查看凭证");
    return view(file, request);
  });
  app.get("/api/v1/files/:id/content", async (request, reply) => {
    const file = await one(pool, "SELECT * FROM files WHERE id=?", [
      request.params.id,
    ]);
    if (!file) fail(404, "文件不存在");
    if (file.scope === "internal") {
      let user = request.user;
      if (!user) {
        const { expires, sid, signature } = request.query;
        if (
          !/^\d{10}$/.test(String(expires || "")) ||
          !/^[a-f0-9]{64}$/.test(sid || "") ||
          Number(expires) < Date.now() / 1000 ||
          Number(expires) > Date.now() / 1000 + 305 ||
          !equal(
            signature,
            hmac(config.fileKey, `${file.id}:${expires}:${sid}`),
          )
        )
          fail(401, "凭证链接无效或已过期");
        const session = await one(
          pool,
          "SELECT user_id,assurance FROM sessions WHERE token_hash=? AND expires_at>UTC_TIMESTAMP(3)",
          [sid],
        );
        if (session)
          user = await loadUser(
            pool,
            session.user_id,
            session.assurance === "staff",
          );
      }
      if (!(await canReadInternal(pool, file, user)))
        fail(user ? 403 : 401, "无权限查看凭证");
    }
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header(
        "Cache-Control",
        file.scope === "internal"
          ? "private, no-store"
          : "public, max-age=86400",
      )
      .type(file.mime);
    return reply.send(
      fs.createReadStream(path.join(root, file.scope, file.stored_name)),
    );
  });
};
module.exports.signFile = signFile;
