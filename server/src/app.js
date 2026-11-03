const Fastify = require("fastify");
const { createPool, one } = require("./db");
const { providers: createProviders } = require("./providers");
const { fail, hash, loadUser } = require("./core");
async function buildApp(config, options = {}) {
  const pool = options.pool || createPool(config.database);
  const app = Fastify({
    logger: false,
    bodyLimit: 1024 * 1024,
    requestTimeout: 60000,
    trustProxy: false,
  });
  app.decorate("db", pool);
  await app.register(require("@fastify/rate-limit"), {
    max: 180,
    timeWindow: "1 minute",
    errorResponseBuilder: () => ({
      statusCode: 429,
      code: 429,
      data: null,
      message: "请求过于频繁，请稍后重试",
    }),
  });
  await app.register(require("@fastify/multipart"), {
    limits: {
      fileSize: 32 * 1024 * 1024,
      files: 1,
      fields: 4,
      parts: 5,
      fieldSize: 500,
    },
  });
  app.decorateRequest("user", null);
  app.decorateRequest("sessionHash", null);
  app.addHook("onRequest", async (request, reply) => {
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Cache-Control", "no-store");
    const authorization = request.headers.authorization;
    if (!authorization) return;
    if (!/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization))
      fail(401, "登录已过期，请重新登录");
    const sessionHash = hash(authorization.slice(7));
    const session = await one(
      pool,
      "SELECT user_id,assurance FROM sessions WHERE token_hash=? AND expires_at>UTC_TIMESTAMP(3)",
      [sessionHash],
    );
    if (!session) fail(401, "登录已过期，请重新登录");
    const user = await loadUser(
      pool,
      session.user_id,
      session.assurance === "staff",
    );
    if (!user) fail(401, "账号已停用");
    if (
      user.staffNo === undefined &&
      !["customer", "peer", "agent"].includes(user.role)
    )
      fail(401, "员工账号已停用");
    request.user = user;
    request.sessionHash = sessionHash;
  });
  const route = (method, url, handler, extra = {}) =>
    app.route({
      method,
      url: "/api/v1" + url,
      ...extra,
      handler: async (request, reply) => ({
        code: 0,
        data: await handler(request, reply),
        message: "ok",
      }),
    });
  const dependencies = {
    pool,
    config,
    providers: options.providers || createProviders(config),
    route,
  };
  await require("./auth")(app, dependencies);
  await require("./catalog")(app, dependencies);
  await require("./inventory")(app, dependencies);
  await require("./purchase")(app, dependencies);
  await require("./files")(app, dependencies);

  dependencies.salesStats = await require("./sales-stats")(app, dependencies);
  dependencies.shareService = await require("./shop-share")(app, dependencies);
  dependencies.agents = await require("./agents")(app, dependencies);
  dependencies.customerRequests = await require("./customer-requests")(
    app,
    dependencies,
  );
  await require("./sales")(app, dependencies);
  dependencies.repair = await require("./repair")(app, dependencies);
  dependencies.loans = await require("./loans")(app, dependencies);
  await require("./analytics")(app, dependencies);
  await require("./report-export")(app, dependencies);
  route("GET", "/health", async () => {
    await pool.execute("SELECT 1");
    return { status: "ready" };
  });
  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({ code: 404, data: null, message: "接口不存在" }),
  );
  app.setErrorHandler((error, request, reply) => {
    let status = error.statusCode || 500,
      message = error.message;
    if (error.code === "ER_DUP_ENTRY") {
      status = 409;
      message = "记录重复或映射冲突，请核对后重试";
    }
    if (
      error.code === "ER_LOCK_DEADLOCK" ||
      error.code === "ER_LOCK_WAIT_TIMEOUT"
    ) {
      status = 409;
      message = "数据正在被其他操作更新，请重试";
    }
    if (status >= 500) {
      message =
        error.statusCode === 503 ? error.message : "服务暂不可用，请稍后重试";
      console.error(
        JSON.stringify({
          requestId: request.id,
          errorCode: error.code || "INTERNAL_ERROR",
        }),
      );
    }
    reply.code(status).send({ code: status, data: null, message });
  });
  app.addHook("onClose", async () => {
    if (!options.pool) await pool.end();
  });
  return app;
}
module.exports = { buildApp };
