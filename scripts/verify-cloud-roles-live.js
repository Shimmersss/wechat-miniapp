#!/usr/bin/env node
/** 真实微信SDK与59页回归。角色/夹具变更在finally恢复；请求只观测，不模拟网络或业务结果。 */
const fs = require("node:fs"),
  crypto = require("node:crypto"),
  assert = require("node:assert/strict");
const {
  pg,
  native,
  evaluate,
  navigate,
  save,
  guest,
  staffLogin,
  privateJSON,
} = require("./lib/cloud-verification");
const manifest = require("../miniprogram/app.json"),
  key = () => crypto.randomUUID();
const pages = [
    ...manifest.pages,
    ...manifest.subPackages.flatMap((p) =>
      p.pages.map((x) => p.root + "/" + x),
    ),
  ],
  roleFixture = privateJSON("role-fixture");
const resumeStaff = process.argv.includes("--resume-staff");
const result = resumeStaff
  ? privateJSON("role-live-results")
  : { pages: [], checks: [] };
let originalUser,
  originalStaff,
  originalAgent,
  currentId,
  newAgent = false,
  session,
  consult;
function ok(r) {
  assert.equal(r.code, 0, r.message);
  return r.data;
}
function fresh() {
  const r = ok(native("auth", "/auth/me"));
  evaluate(
    function (u) {
      wx.setStorageSync("xm_user", u);
      getApp().globalData.user = u;
      wx.removeStorageSync("xm_channel");
    },
    [r],
  );
  return r;
}
async function page(route, query = {}) {
  const suffix = new URLSearchParams(query).toString(),
    tab = manifest.tabBar.list.some((t) => t.pagePath === route);
  navigate(
    "/" + route + (suffix ? "?" + suffix : ""),
    tab ? "switchTab" : "reLaunch",
  );
  let state,
    stable = 0;
  for (let i = 0; i < 18; i++) {
    state = evaluate(function () {
      const p = getCurrentPages().slice(-1)[0];
      const a = getApp();
      return {
        route: p?.route,
        error: p?.data.error || "",
        pending: a.globalData.__rolePending || 0,
        loading: !!p?.data.loading,
        listLoading: !!p?.data.listLoading,
        historyLoading: !!p?.data.historyLoading,
      };
    });
    if (
      state.route === route &&
      !state.pending &&
      !state.loading &&
      !state.listLoading &&
      !state.historyLoading
    ) {
      if (++stable >= 2) break;
    } else stable = 0;
    await new Promise((r) => setTimeout(r, 180));
  }
  assert.equal(state.route, route, "页面守卫或路由不符合当前角色：" + route);
  assert.equal(state.error, "", route + ": " + state.error);
  assert.equal(state.pending, 0, route + " 请求未完成");
  result.pages.push({ page: route, passed: true });
  save("role-live-progress", { pages: result.pages, checks: result.checks });
}
(async () => {
  const who = await guest();
  currentId = who.id;
  originalUser = (await pg("users?id=eq." + currentId))[0];
  originalStaff = (await pg("staff?user_id=eq." + currentId))[0];
  originalAgent = (await pg("agents?user_id=eq." + currentId))[0];
  assert.ok(originalStaff);
  save("role-live-original", {
    user: originalUser,
    staff: originalStaff,
    agent: originalAgent || null,
  });
  evaluate(function () {
    const app = getApp();
    app.globalData.__roleLogs = [];
    app.globalData.__rolePending = 0;
    const original = wx.cloud.callFunction;
    app.globalData.__roleCloudOriginal = original;
    wx.cloud.callFunction = function (o) {
      app.globalData.__rolePending++;
      const done = (r, error) => {
        app.globalData.__rolePending--;
        app.globalData.__roleLogs.push({
          name: o.name,
          path: o.data?.path,
          code: r?.result?.code,
          error: !!error,
          route: getCurrentPages().slice(-1)[0]?.route,
        });
      };
      if (o.success || o.fail)
        return original.call(this, {
          ...o,
          success: (r) => {
            done(r);
            o.success?.(r);
          },
          fail: (e) => {
            done(null, true);
            o.fail?.(e);
          },
        });
      return original.call(this, o).then(
        (r) => {
          done(r);
          return r;
        },
        (e) => {
          done(null, true);
          throw e;
        },
      );
    };
  });
  try {
    if (!resumeStaff) {
      await pg("users?id=eq." + currentId, "PATCH", {
        role: "customer",
        agent_status: null,
        status: "active",
      });
      await guest();
      consult = ok(
        native("customer", "/shop/consults", "POST", {
          requestKey: key(),
          unitId: roleFixture.unitId,
          name: "微信角色回归",
          phone: "199" + String(crypto.randomInt(1e8)).padStart(8, "0"),
          content: "真实页面咨询回归",
        }),
      );
      const share = ok(
        native("agent", "/share/links", "POST", {
          unitId: roleFixture.unitId,
          channel: "customer",
        }),
      );
      for (const route of pages.filter(
        (p) =>
          p.startsWith("pages/") ||
          p.startsWith("packages/shop/") ||
          p === "packages/agent/apply/index" ||
          p === "packages/demo/home/index",
      )) {
        const q =
          route === "packages/shop/product/index"
            ? { id: roleFixture.unitId }
            : route === "packages/shop/requests/detail"
              ? { id: consult.id }
              : route === "packages/shop/collection/index"
                ? { s: share.shareId }
                : route === "packages/shop/poster/index"
                  ? { shareId: share.shareId, unitId: roleFixture.unitId }
                  : route === "packages/shop/consult/index"
                    ? { unitId: roleFixture.unitId }
                    : {};
        await page(route, q);
      }
      assert.equal(
        native("staff-stock", "/units/" + roleFixture.unitId).code,
        403,
      );
      assert.equal(native("agent", "/agent/overview").code, 403);
      navigate("/packages/agent/center/index", "reLaunch");
      await new Promise((r) => setTimeout(r, 500));
      const blocked = evaluate(function () {
        return getCurrentPages().slice(-1)[0]?.route;
      });
      assert.notEqual(blocked, "packages/agent/center/index");
      result.checks.push(
        "真实顾客浏览/分类/详情/咨询/本人记录/分享/海报页面；员工API和代理中心守卫拒绝",
      );
      await pg("users?id=eq." + currentId, "PATCH", { role: "peer" });
      await guest();
      const peer = ok(native("shop", "/shop/units/" + roleFixture.unitId));
      assert.equal(peer.price, 1400);
      assert.equal(peer.cost, undefined);
      assert.equal(peer.imei1, undefined);
      await page("packages/shop/product/index", { id: roleFixture.unitId });
      result.checks.push(
        "真实微信同行会话拿同行价、无成本/完整串码，详情页加载",
      );
      await pg("users?id=eq." + currentId, "PATCH", {
        role: "agent",
        agent_status: "active",
      });
      if (originalAgent)
        await pg("agents?user_id=eq." + currentId, "PATCH", {
          status: "active",
          markup_max: 100,
        });
      else {
        await pg("agents", "POST", {
          user_id: currentId,
          status: "active",
          name: "临时微信页面角色夹具",
          phone: "199" + String(crypto.randomInt(1e8)).padStart(8, "0"),
          region: "测试地区",
          markup_max: 100,
          invite_code: crypto.randomBytes(4).toString("hex").toUpperCase(),
        });
        newAgent = true;
      }
      await guest();
      assert.equal(ok(native("agent", "/agent/me")).status, "active");
      for (const route of pages.filter(
        (p) => p.startsWith("packages/agent/") && !p.includes("/apply/"),
      ))
        await page(route, { unitId: roleFixture.unitId });
      const agents = ok(native("agent", "/agent/units"));
      assert.ok(
        agents.list.every(
          (u) =>
            u.cost === undefined &&
            u.agentBase === undefined &&
            u.wholesale === undefined &&
            u.imei1 === undefined,
        ),
      );
      result.checks.push(
        "真实微信代理中心/加价/订单/收益/邀请页面，代理库存不返回底价、成本及完整串码",
      );
    }
    if (!consult)
      consult = (
        await pg(
          "customer_requests?owner_id=eq." +
            currentId +
            "&kind=eq.consult&order=created_at.desc&select=id&limit=1",
        )
      )[0];
    assert.ok(consult);
    await pg("users?id=eq." + currentId, "PATCH", {
      role: "customer",
      agent_status: null,
    });
    await pg("staff?id=eq." + originalStaff.id, "PATCH", {
      role_key: "boss",
      status: "active",
    });
    await staffLogin();
    const supplier = ok(
      native("staff-stock", "/suppliers", "POST", {
        name: "页面回归供应商-" + key().slice(0, 8),
      }),
    );
    const purchaseBody = {
      supplierId: supplier.id,
      lines: [{ modelId: roleFixture.modelId, quantity: 1, unitCost: 1000 }],
      expectedAt: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
    };
    const editable = ok(
        native("staff-stock", "/purchase-orders", "POST", purchaseBody),
      ),
      arrived = ok(
        native("staff-stock", "/purchase-orders", "POST", purchaseBody),
      );
    const shipment = ok(
      native(
        "staff-stock",
        "/purchase-orders/" + arrived.id + "/shipments",
        "POST",
        {
          carrier: "OTHER",
          trackingNo: "ROLE" + key().replaceAll("-", "").slice(0, 12),
        },
      ),
    );
    ok(
      native("staff-stock", "/shipments/" + shipment.id + "/receive", "POST", {
        reason: "页面回归手工确认已收货",
      }),
    );
    const template = ok(
      native("staff-stock", "/models/" + roleFixture.modelId + "/form"),
    );
    const stocktake = ok(
      native("staff-stock", "/stocktake-sessions", "POST", {
        requestKey: key(),
        modelId: roleFixture.modelId,
        statuses: ["in_stock"],
        note: "页面回归开盘不改库存",
      }),
    );
    session = stocktake;
    const closed = (await pg("stocktakes?select=id&limit=1"))[0];
    assert.ok(closed);
    const loan = privateJSON("loans-fixture"),
      repair = privateJSON("repair-fixture"),
      sale = privateJSON("reports-fixture");
    const queries = {
      "packages/staff/purchase/detail": { id: arrived.id },
      "packages/staff/purchase/edit": { id: editable.id },
      "packages/staff/acceptance/index": { poId: arrived.id },
      "packages/staff/templates/edit": { id: template.id },
      "packages/staff/inventory/detail": { id: roleFixture.unitId },
      "packages/staff/inventory/label": { id: roleFixture.unitId },
      "packages/staff/sales/detail": { id: sale.saleId },
      "packages/staff/repair/detail": { id: repair.orderId },
      "packages/staff/loans/detail": { id: loan.orderId },
      "packages/staff/inventory/stocktake-run": { id: stocktake.id },
      "packages/staff/inventory/stocktake-result": { id: closed.id },
      "packages/staff/consults/detail": { id: consult.id },
    };
    for (const route of pages.filter(
      (p) =>
        p.startsWith("packages/staff/") ||
        (p.startsWith("packages/demo/") && !p.includes("/home/")),
    ))
      await page(route, queries[route] || {});
    result.checks.push(
      "真实老板会话加载全部员工经营页与演示经营页，含采购/验收/库存/模板/盘点/借还/维修/销售/统计/审计/员工角色",
    );
    for (const role of [
      "sales",
      "manager",
      "purchaser",
      "warehouse",
      "engineer",
      "finance",
    ]) {
      await pg("staff?id=eq." + originalStaff.id, "PATCH", { role_key: role });
      const user = fresh();
      if (user.permissions.includes("inventory:view")) {
        const unit = ok(native("staff-stock", "/units/" + roleFixture.unitId));
        assert.equal(
          unit.cost !== undefined,
          user.visibleFields.includes("cost"),
        );
        assert.equal(
          unit.imei1 !== undefined,
          user.visibleFields.includes("fullImei"),
        );
      }
      if (role === "sales") {
        await page("packages/staff/inventory/list");
        await page("packages/staff/pos/index");
        assert.equal(native("staff-admin", "/staff").code, 403);
        assert.equal(native("staff-reports", "/audit-logs").code, 403);
      }
      if (role === "engineer") {
        const board = ok(native("staff-repair", "/repair-orders/board"));
        assert.ok(
          Object.values(board.columns)
            .flat()
            .every((o) => o.engineerId === currentId),
        );
      }
    }
    await pg("staff?id=eq." + originalStaff.id, "PATCH", {
      status: "disabled",
    });
    const denied = native("staff-stock", "/units/" + roleFixture.unitId);
    assert.equal(denied.code, 403);
    result.checks.push(
      "同一个真实微信令牌切换销售/经理/采购/库管/工程师/财务即时生效；成本/串码裁剪、销售管理拒绝与停用拒绝",
    );
    const logs = evaluate(function () {
      return getApp().globalData.__roleLogs;
    });
    const errors = logs.filter(
      (x) => x.error || [404, 500, 501, 503].includes(x.code),
    );
    assert.deepEqual(errors, [], "页面请求存在未迁移或服务错误");
    result.requestCount = logs.length;
    result.uniquePages = new Set(result.pages.map((p) => p.page)).size;
    assert.equal(result.uniquePages, 59);
    result.passed = true;
  } finally {
    // 原始业务数据恢复；新增无业务关联的临时代理夹具先存原始证据，再撤销它以恢复原来的不存在状态。
    if (newAgent) {
      save(
        "role-live-temporary-agent",
        await pg("agents?user_id=eq." + currentId),
      );
      await pg("agents?user_id=eq." + currentId, "DELETE");
    } else if (originalAgent)
      await pg("agents?user_id=eq." + currentId, "PATCH", originalAgent);
    await pg("users?id=eq." + currentId, "PATCH", {
      role: originalUser.role,
      agent_status: originalUser.agent_status,
      status: originalUser.status,
    });
    await pg("staff?id=eq." + originalStaff.id, "PATCH", {
      role_key: "boss",
      status: "active",
    });
    await staffLogin();
    if (session)
      ok(
        native(
          "staff-stock",
          "/stocktake-sessions/" + session.id + "/cancel",
          "POST",
          { reason: "结束页面回归夹具，盘点未提交且不改库存" },
        ),
      );
    await pg("staff?id=eq." + originalStaff.id, "PATCH", {
      role_key: originalStaff.role_key,
      status: originalStaff.status,
    });
    await guest();
    evaluate(function () {
      const a = getApp();
      if (a.globalData.__roleCloudOriginal)
        wx.cloud.callFunction = a.globalData.__roleCloudOriginal;
      delete a.globalData.__roleCloudOriginal;
      delete a.globalData.__rolePending;
      delete a.globalData.__roleLogs;
      wx.removeStorageSync("xm_channel");
    });
    navigate("/pages/shop/index", "switchTab");
    result.restored = {
      role: originalStaff.role_key,
      status: originalStaff.status,
      userRole: originalUser.role,
      agentProfileRestored: true,
      customerSession: true,
    };
    save("role-live-results", result);
  }
  console.log(JSON.stringify(result));
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
