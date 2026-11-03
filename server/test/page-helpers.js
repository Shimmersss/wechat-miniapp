const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "../..");
function client(f, role) {
  async function send(method, url, data, opts = {}) {
    if (method === "GET" && data) {
      const query = new URLSearchParams(
        Object.entries(data).filter(
          ([, v]) => v !== undefined && v !== null && v !== "",
        ),
      );
      if (query.size) url += "?" + query;
      data = undefined;
    }
    const response = await f.api(method, url, data, role, opts.header || {});
    if (response.status !== 200)
      throw Object.assign(new Error(response.message), {
        code: response.status,
      });
    return response.data;
  }
  const http = Object.fromEntries(
    ["get", "post", "put", "patch", "del"].map((method) => [
      method,
      (url, data, opts) =>
        send(
          method === "del" ? "DELETE" : method.toUpperCase(),
          url,
          data,
          opts,
        ),
    ]),
  );
  const api = {};
  for (const name of [
    "loan",
    "dashboard",
    "purchase",
    "supplier",
    "template",
    "inbound",
    "inventory",
    "file",
    "sales",
    "repair",
    "stats",
    "shop",
    "customer-request",
    "share",
  ]) {
    const context = { module: { exports: {} }, require: () => ({ http }) };
    vm.runInNewContext(
      fs.readFileSync(
        path.join(root, "miniprogram/api/modules", name + ".js"),
        "utf8",
      ),
      context,
    );
    api[name === "customer-request" ? "customerRequest" : name] =
      context.module.exports;
  }
  return api;
}
function page(relative, api, role = "boss", overrides = {}) {
  let definition;
  const confirmations = [],
    navigation = [],
    notices = [];
  const context = {
    require(name, source = path.join(root, relative)) {
      const resolved = path.resolve(path.dirname(source), name);
      if (name.endsWith("/utils/page"))
        return {
          createPage: (options) => {
            definition = options;
          },
        };
      if (name.endsWith("/api/index")) return api;
      if (resolved === path.join(root, "miniprogram/utils/confirm"))
        return {
          confirmSensitive: async (options) => {
            confirmations.push(options);
            return { confirmed: true, reason: "验证用人工处理说明" };
          },
        };
      if (name.endsWith("/utils/scan")) return {};
      if (name.endsWith("/utils/request")) return {};
      if (
        resolved === path.join(root, "miniprogram/utils/customer-request-page")
      ) {
        const nested = {
          ...context,
          module: { exports: {} },
          require: (n) => context.require(n, resolved + ".js"),
        };
        vm.runInNewContext(fs.readFileSync(resolved + ".js", "utf8"), nested, {
          filename: resolved + ".js",
        });
        return nested.module.exports;
      }
      return require(resolved);
    },
    getCurrentPages: () => [definition, {}],
    wx: {},
    ...overrides,
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(root, relative), "utf8"),
    context,
    { filename: relative },
  );
  definition.data = JSON.parse(JSON.stringify(definition.data));
  const { ROLE_PERMISSIONS } = require("../../miniprogram/constants/roles");
  definition.data.user = { role, permissions: ROLE_PERMISSIONS[role] };
  definition.setData = (patch) =>
    Object.entries(patch).forEach(([key, value]) => {
      const parts = key.replace(/\[(\d+)\]/g, ".$1").split(".");
      let object = definition.data;
      for (const part of parts.slice(0, -1)) object = object[part];
      object[parts.at(-1)] = value;
    });
  definition.$toast = (message) => notices.push(message);
  definition.$go = (route, query) => navigation.push({ route, query });
  definition.$back = () => navigation.push("back");
  Object.assign(definition, { confirmations, navigation, notices });
  return definition;
}
module.exports = { client, page };
