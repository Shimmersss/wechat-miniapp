#!/usr/bin/env node
/** 只提取调用及路由元数据，不执行业务处理器或网络请求；不能代替真实云端业务验证。 */
const fs = require("fs"),
  path = require("path"),
  vm = require("vm");
const root = path.resolve(__dirname, "..");
function discover() {
  process.chdir(root);
  const methods = ["get", "post", "put", "patch", "delete"];
  const http = Object.fromEntries(
    methods.map((m) => [m, (url) => ({ method: m.toUpperCase(), path: url })]),
  );
  const aliases = Object.fromEntries(
    [
      ...fs
        .readFileSync(path.join(root, "miniprogram/api/index.js"), "utf8")
        .matchAll(/(\w+): require\('\.\/modules\/([^']+)'\)/g),
    ].map((m) => [m[2], m[1]]),
  );
  const apis = [];
  for (const f of fs
    .readdirSync("miniprogram/api/modules")
    .filter((f) => f.endsWith(".js"))) {
    const mod = { exports: {} };
    vm.runInNewContext(
      fs.readFileSync("miniprogram/api/modules/" + f, "utf8"),
      { module: mod, require: () => ({ http }) },
    );
    for (const [name, fn] of Object.entries(mod.exports)) {
      try {
        const d = fn(":id", ":id", ":id");
        apis.push({
          module: aliases[f.replace(/\.js$/, "")] || f.replace(/\.js$/, ""),
          name,
          ...d,
        });
      } catch (e) {
        apis.push({ module: f, name, error: e.message });
      }
    }
  }
  const routes = [];
  const noop = new Proxy(
    function () {
      return noop;
    },
    { get: () => noop },
  );
  for (const f of fs
    .readdirSync("cloudfunctions")
    .filter((f) => fs.existsSync("cloudfunctions/" + f + "/index.js"))) {
    const ex = {};
    vm.runInNewContext(
      fs.readFileSync("cloudfunctions/" + f + "/index.js", "utf8"),
      {
        exports: ex,
        process,
        Buffer,
        console,
        require(name) {
          if (name.endsWith("/gateway"))
            return {
              createHandler: (rs) => {
                routes.push(
                  ...rs.map(([method, p]) => ({ fn: f, method, path: p })),
                );
                return noop;
              },
            };
          if (name.endsWith("/roles"))
            return require(path.join(root, "miniprogram/constants/roles"));
          if (name.endsWith("/startup-timing")) return (x) => x;
          if (name === "node:crypto") return require(name);
          return noop;
        },
      },
    );
  }
  const text = fs.readFileSync("miniprogram/utils/request.js", "utf8");
  const map = vm.runInNewContext(
    "(" + text.match(/const CLOUD_FUNCTIONS = (\{[\s\S]*?\});/)[1] + ")",
  );
  function matches(pattern, p) {
    return (
      pattern.split("/").length === p.split("/").length &&
      pattern
        .split("/")
        .every((v, i) => v.startsWith(":") || v === p.split("/")[i])
    );
  }
  // 上传工具直接调用request，未经过api/modules；独立提取，避免只核对页面API包装器。
  const utilityRoutes = [
    ...text.matchAll(
      /(?<![\w.])request\(\{\s*url:\s*([^,]+),\s*method:\s*'([^']+)'/g,
    ),
  ].map((m) => ({
    module: "utils/request",
    method: m[2],
    path: vm.runInNewContext(m[1], {
      encodeURIComponent: () => ":id",
      intent: { uploadId: ":id" },
    }),
  }));
  for (const a of [...apis, ...utilityRoutes]) {
    const bits = a.path?.split("/").filter(Boolean) || [];
    a.fn = map[bits.slice(0, 2).join("/")] || map[bits[0]];
    a.covered = routes.some(
      (r) => r.fn === a.fn && r.method === a.method && matches(r.path, a.path),
    );
  }

  const manifest = JSON.parse(fs.readFileSync("miniprogram/app.json"));
  const pagePaths = [
    ...manifest.pages,
    ...manifest.subPackages.flatMap((p) =>
      p.pages.map((x) => p.root + "/" + x),
    ),
  ];
  function dependencies(file, seen = new Set()) {
    if (seen.has(file) || !fs.existsSync(file)) return seen;
    seen.add(file);
    const source = fs.readFileSync(file, "utf8");
    for (const m of source.matchAll(/require\(['"](\.[^'"]+)['"]\)/g)) {
      let next = path.resolve(path.dirname(file), m[1]);
      if (!next.endsWith(".js")) next += ".js";
      if (
        next.endsWith("/api/index.js") ||
        next.endsWith("/utils/request.js") ||
        !next.startsWith(path.join(root, "miniprogram"))
      )
        continue;
      dependencies(next, seen);
    }
    return seen;
  }
  function usage(files) {
    const uses = new Set(),
      dynamic = [];
    let uploads = false;
    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      for (const m of source.matchAll(
        /(?<![\w/])api\s*\.\s*(\w+)(?:\s*\.\s*(\w+))?/g,
      )) {
        if (m[2]) uses.add(m[1] + "." + m[2]);
        else {
          for (const a of apis.filter((a) => a.module === m[1]))
            uses.add(a.module + "." + a.name);
          dynamic.push({
            file: path.relative(root, file),
            domain: m[1],
            note: "domain reference conservatively includes all methods; actual selectors manually reviewed",
          });
        }
      }
      if (
        /require\([^)]*utils\/request/.test(source) &&
        /\bupload\s*\(/.test(source)
      )
        uploads = true;
    }
    return { api: [...uses].sort(), dynamic, uploads };
  }
  const pages = pagePaths.map((p) => {
    const files = [...dependencies(path.join(root, "miniprogram", p + ".js"))],
      u = usage(files);
    return {
      page: p,
      demo: p.startsWith("packages/demo/"),
      direct: usage([path.join(root, "miniprogram", p + ".js")]).api,
      ...u,
      dependencies: files.map((f) => path.relative(root, f)),
      unknown: u.api.filter(
        (key) => !apis.some((a) => a.module + "." + a.name === key),
      ),
    };
  });
  const missing = [...apis, ...utilityRoutes].filter((a) => !a.covered),
    unknownPages = pages.filter((p) => p.unknown.length);
  const result = {
    summary: {
      pages: pages.length,
      demoPages: pages.filter((p) => p.demo).length,
      apiMethods: apis.length,
      utilityRoutes: utilityRoutes.length,
      cloudRoutes: routes.length,
      missing: missing.length,
      unknownPages: unknownPages.length,
    },
    apis,
    utilityRoutes,
    routes,
    pages,
    missing,
  };
  return result;
}
if (require.main === module) {
  const result = discover();
  const target = process.argv[2];
  if (target) fs.writeFileSync(target, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result.summary));
  if (result.missing.length) console.log(JSON.stringify(result.missing));
  if (result.summary.unknownPages)
    console.log(
      JSON.stringify(
        result.pages
          .filter((p) => p.unknown.length)
          .map((p) => ({ page: p.page, unknown: p.unknown })),
      ),
    );
  process.exitCode =
    result.missing.length || result.summary.unknownPages ? 1 : 0;
}
module.exports = { discover };
