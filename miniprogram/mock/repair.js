const {
  PERM,
  ROLE_PERMISSIONS,
  SENSITIVE_FIELDS,
} = require("../constants/roles");
const { TRANSITIONS } = require("../constants/repair");
const { REPAIR_FLOW } = require("../constants/status");
const { isPhone, isImei } = require("../utils/validate");
module.exports = function (
  db,
  { fail, currentRole, requirePermission, paginate, clone, uploadedFiles },
) {
  const orders = (db.repairTransactions = db.repairTransactions || []),
    parts = (db.repairParts = db.repairParts || []),
    ledger = (db.repairPartLedger = db.repairPartLedger || []);
  let seq = 0;
  const uid = () => "repair_" + Date.now() + "_" + ++seq,
    actor = () => "mock_" + currentRole(),
    has = (p) => (ROLE_PERMISSIONS[currentRole()] || []).includes(p),
    cost = () => SENSITIVE_FIELDS.cost.includes(currentRole()),
    profit = () =>
      SENSITIVE_FIELDS.profit.includes(currentRole()) && has(PERM.PROFIT_VIEW),
    all = () =>
      [PERM.REPAIR_ASSIGN, PERM.REPAIR_QUOTE, PERM.REPAIR_CASH].some(has),
    closed = (s) => ["completed", "cancelled"].includes(s);
  const signature = (v) => JSON.stringify(canonical(v));
  function canonical(v) {
    return Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === "object"
        ? Object.keys(v)
            .sort()
            .reduce((r, k) => ((r[k] = canonical(v[k])), r), {})
        : v;
  }
  const number = (v, min = 1, max = 1000000) => {
    if (!/^\d+$/.test(String(v)) || Number(v) < min || Number(v) > max)
      fail(400, "整数参数无效");
    return Number(v);
  };
  const cents = (v) => {
    if (!/^\d{1,12}(\.\d{1,2})?$/.test(String(v)))
      fail(400, "金额须为非负金额，最多两位小数");
    const amount = Math.round(Number(v) * 100);
    if (!Number.isSafeInteger(amount) || amount > 99999999999999)
      fail(400, "金额超出范围");
    return amount;
  };
  function read(o) {
    requirePermission(PERM.REPAIR_HANDLE, PERM.REPAIR_QUOTE, PERM.REPAIR_CASH);
    if (o && !all() && o.engineerId !== actor()) fail(404, "维修单不存在");
  }
  function write(o) {
    read(o);
    requirePermission(PERM.REPAIR_HANDLE);
    if (!has(PERM.REPAIR_ASSIGN) && o.engineerId !== actor())
      fail(403, "仅可处理本人获分派工单");
  }
  const find = (id) =>
    orders.find((o) => o.id === id) || fail(404, "维修单不存在");
  function canReadFile(id) {
    const linked = orders.filter((o) => o.files.some((f) => f.fileId === id));
    if (!linked.length) return undefined;
    if (
      linked.some((o) =>
        o.files.some((f) => f.fileId === id && f.purpose === "expense"),
      )
    )
      return has(PERM.REPAIR_CASH) && cost();
    return linked.some((o) =>
      o.files.some(
        (f) =>
          f.fileId === id &&
          (f.purpose === "payment"
            ? has(PERM.REPAIR_CASH)
            : (has(PERM.REPAIR_HANDLE) &&
                (has(PERM.REPAIR_ASSIGN) || o.engineerId === actor())) ||
              (has(PERM.REPAIR_CASH) && f.purpose === "pickup")),
      ),
    );
  }
  function images(values) {
    if (values === undefined) return [];
    if (!Array.isArray(values) || values.length > 9) fail(400, "附件最多9张");
    const ids = new Set();
    return values.map((v) => {
      if (ids.has(v.fileId)) fail(400, "附件重复");
      ids.add(v.fileId);
      const f = uploadedFiles.get(v.fileId) || fail(400, "附件不存在");
      if((db.loanTransactions||[]).some(o=>o.photos.some(p=>p.fileId===f.fileId)))fail(400,"借还凭证不能作为维修附件");
      if (f.scope !== "internal") fail(400, "维修附件须单独上传为内部图片");
      if (
        canReadFile(v.fileId) === false ||
        (!["boss", "manager", "purchaser"].includes(currentRole()) &&
          f.ownerRole !== currentRole() &&
          canReadFile(v.fileId) !== true)
      )
        fail(403, "无权引用附件");
      if (
        db.units.some((u) =>
          Object.values(u.attributes || {})
            .filter(Array.isArray)
            .some((items) => items.some((i) => i?.fileId === v.fileId)),
        )
      )
        fail(400, "入库凭证不能用于维修");
      return { fileId: f.fileId, url: f.url, scope: "internal" };
    });
  }
  const totals = (o) => ({
    received: o.payments.reduce(
      (n, p) =>
        n + (p.kind === "receipt" ? 1 : p.kind === "refund" ? -1 : 0) * p.cents,
      0,
    ),
    expenses: o.payments.reduce(
      (n, p) =>
        n +
        (p.kind === "expense" ? 1 : p.kind === "expense_refund" ? -1 : 0) *
          p.cents,
      0,
    ),
    parts: ledger
      .filter((l) => l.orderId === o.id)
      .reduce((n, l) => n + (l.kind === "issue" ? 1 : -1) * l.cents, 0),
  });
  function view(o) {
    read(o);
    const t = totals(o),
      out = clone(o);
    delete out.creator;
    delete out.requestKey;
    delete out.signature;
    delete out.operations;
    delete out.identifier;
    if (SENSITIVE_FIELDS.fullImei.includes(currentRole()))
      out.identifier = o.identifier;
    out.imeiMasked =
      o.identifier && o.identifier.length > 6
        ? o.identifier.slice(0, 2) + "****" + o.identifier.slice(-4)
        : "***";
    out.engineer = o.engineerId ? "维修工程师" : "未分派";
    out.received = t.received / 100;
    out.quote = o.quote === null ? null : o.quote / 100;
    out.files = out.files.filter((f) => canReadFile(f.fileId));
    out.parts = ledger
      .filter((l) => l.orderId === o.id && l.kind === "issue")
      .map((l) => ({
        id: l.id,
        partId: l.partId,
        name: parts.find((p) => p.id === l.partId).name,
        quantity: l.quantity,
        returned: ledger
          .filter((r) => r.issueId === l.id)
          .reduce((n, r) => n + r.quantity, 0),
        ...(cost() ? { cost: l.cents / 100 } : {}),
      }));
    out.payments = o.payments
      .filter((p) => cost() || !p.kind.startsWith("expense"))
      .map((p) => ({
        id: p.id,
        kind: p.kind,
        amount: p.cents / 100,
        method: p.method,
        reason: p.reason,
        time: p.time,
      }));
    if (cost()) {
      out.partsCost = t.parts / 100;
      out.expenses = t.expenses / 100;
    } else delete out.costAllocation;
    if (profit())
      out.profit =
        o.kind === "external"
          ? (t.received - t.parts - t.expenses) / 100
          : null;
    out.timeline = out.timeline.map((e) => {
      if (!cost()) delete e.costData;
      return e;
    });
    Object.assign(out, {
      canManage:
        has(PERM.REPAIR_HANDLE) &&
        (has(PERM.REPAIR_ASSIGN) || o.engineerId === actor()),
      canQuote: has(PERM.REPAIR_QUOTE),
      canAssign: has(PERM.REPAIR_ASSIGN),
      canCash: has(PERM.REPAIR_CASH),
      canRefund: has(PERM.REPAIR_CASH) && has(PERM.REFUND),
      canExpense: has(PERM.REPAIR_CASH) && cost(),
      overdue:
        !closed(o.status) &&
        !!o.expectedAt &&
        o.expectedAt <
          new Date(Date.now() + 28800000).toISOString().slice(0, 10),
    });
    return out;
  }
  function audit(action, target, reason) {
    db.auditLogs.unshift({
      id: uid(),
      time: new Date().toISOString(),
      operator: currentRole(),
      action,
      detail: target,
      reason,
    });
  }
  function finish(o) {
    if (o.kind !== "inventory") return;
    const u = db.units.find((u) => u.id === o.unitId);
    if (!u || u.status !== "repairing") fail(409, "库存维修状态已变化");
    const t = totals(o),
      old = u.cost;
    if (
      !Number.isSafeInteger(cents(u.cost) + t.parts + t.expenses) ||
      cents(u.cost) + t.parts + t.expenses > 99999999999999
    )
      fail(400, "成本超出范围");
    u.cost = Math.round((u.cost + (t.parts + t.expenses) / 100) * 100) / 100;
    u.status = "recheck";
    u.flags = { showInShop: false, sharePeer: false, shareAgent: false };
    o.costAllocation = {
      time: new Date().toISOString(),
      policy: "capitalize",
      old_unit_cost: old,
      new_unit_cost: u.cost,
      total_cost: (t.parts + t.expenses) / 100,
    };
    db.inventoryLedger = db.inventoryLedger || [];
    db.inventoryLedger.unshift({
      id: uid(),
      unitId: u.id,
      from: "repairing",
      to: "recheck",
      docType: "repair_done",
      doc: o.id,
      operator: currentRole(),
      reason: "维修结束待复检",
      time: new Date().toISOString(),
    });
  }
  function attach(o, files, purpose) {
    if (
      purpose !== "expense" &&
      files.some((f) =>
        orders.some((o) =>
          o.files.some((v) => v.fileId === f.fileId && v.purpose === "expense"),
        ),
      )
    )
      fail(400, "费用凭证不能转为普通附件");
    if (
      new Set(
        o.files
          .filter((f) => f.purpose === purpose)
          .map((f) => f.fileId)
          .concat(files.map((f) => f.fileId)),
      ).size > 9
    )
      fail(400, "每组维修附件最多9张");
    files.forEach((f) => {
      if (!o.files.some((v) => v.fileId === f.fileId && v.purpose === purpose))
        o.files.push({ ...f, purpose });
    });
  }
  function mutate(d, p, action, guard, fn) {
    const o = find(p.id);
    guard(o);
    if (!d.requestKey || !d.reason?.trim()) fail(400, "请填写操作标识和说明");
    const sig = signature({ action, actor: actor(), ...d });
    if (o.operations[d.requestKey]) {
      if (o.operations[d.requestKey] !== sig) fail(409, "操作标识内容冲突");
      return view(o);
    }
    if (d.version !== o.version) fail(409, "版本已变化");
    const allowed =
      {
        update: [
          "customer",
          "phone",
          "engineerId",
          "expectedAt",
          "diagnosis",
          "waitingParts",
          "fault",
          "photos",
        ],
        quote: ["amount"],
        confirm: ["confirmed", "quoteVersion"],
        issue: ["partId", "quantity"],
        return_parts: ["issueId", "quantity"],
        payment: ["kind", "amount", "method", "confirmed", "proof"],
        transition: [
          "to",
          "result",
          "pickupName",
          "pickupProof",
          "warrantyDays",
        ],
      }[action] || [];
    if (
      Object.keys(d).some(
        (k) => !["requestKey", "version", "reason", ...allowed].includes(k),
      )
    )
      fail(400, "操作参数无效");
    const from = o.status,
      snapshot = clone(o),
      unit = o.unitId ? db.units.find((u) => u.id === o.unitId) : null,
      unitSnapshot = unit ? clone(unit) : null,
      partSnapshots = parts.map((p) => clone(p)),
      ledgerSnapshot = clone(ledger),
      inventorySnapshot = (db.inventoryLedger || []).slice();
    let result;
    try {
      result = fn(o) || {};
    } catch (error) {
      for (const k of Object.keys(o)) delete o[k];
      Object.assign(o, snapshot);
      if (unit) {
        for (const k of Object.keys(unit)) delete unit[k];
        Object.assign(unit, unitSnapshot);
      }
      for (const saved of partSnapshots) {
        const p = parts.find((p) => p.id === saved.id);
        for (const k of Object.keys(p)) delete p[k];
        Object.assign(p, saved);
      }
      ledger.splice(0, ledger.length, ...ledgerSnapshot);
      if (db.inventoryLedger)
        db.inventoryLedger.splice(
          0,
          db.inventoryLedger.length,
          ...inventorySnapshot,
        );
      throw error;
    }
    o.version++;
    o.updatedAt = new Date().toISOString();
    o.timeline.push({
      id: uid(),
      action,
      from,
      to: o.status,
      version: o.version,
      note: d.reason,
      time: o.updatedAt,
      operator: currentRole(),
      data: result.data || {},
      ...(result.costData ? { costData: result.costData } : {}),
    });
    o.operations[d.requestKey] = sig;
    audit("维修处理:" + action, o.id, d.reason);
    return view(o);
  }
  const cash = (o) => {
    read(o);
    requirePermission(PERM.REPAIR_CASH);
  };
  const filter = (d) => {
    read();
    return orders.filter(
      (o) =>
        (all() || o.engineerId === actor()) &&
        (!d.status || d.status === o.status) &&
        (!d.engineerId || d.engineerId === o.engineerId) &&
        (!d.keyword || (o.no + o.model + o.customer).includes(d.keyword)) &&
        (d.waitingParts !== "true" || o.waitingParts) &&
        (d.overdue !== "true" ||
          (!closed(o.status) &&
            !!o.expectedAt &&
            o.expectedAt <
              new Date(Date.now() + 28800000).toISOString().slice(0, 10))),
    );
  };
  function partView(p) {
    return {
      id: p.id,
      sku: p.sku,
      name: p.name,
      unit: p.unit,
      quantity: p.quantity,
      version: p.version,
      active: true,
      ...(cost() ? { stockValue: p.value / 100 } : {}),
    };
  }
  function partManage() {
    requirePermission(PERM.PARTS_MANAGE);
    if (!cost()) fail(403, "无权登记配件成本");
  }
  function move(o, d, returning) {
    if (
      !(returning ? ["repairing", "pending_pickup"] : ["repairing"]).includes(
        o.status,
      )
    )
      fail(409, "当前节点不能领退料");
    const qty = number(d.quantity);
    let issue,
      partId = d.partId,
      amount;
    if (returning) {
      issue =
        ledger.find(
          (l) => l.id === d.issueId && l.orderId === o.id && l.kind === "issue",
        ) || fail(404, "原领用不存在");
      partId = issue.partId;
    }
    const p = parts.find((p) => p.id === partId) || fail(404, "配件不存在");
    if (returning) {
      const returned = ledger.filter((l) => l.issueId === issue.id),
        left = issue.quantity - returned.reduce((n, r) => n + r.quantity, 0),
        remaining = issue.cents - returned.reduce((n, r) => n + r.cents, 0);
      if (qty > left) fail(400, "超过原领用数量");
      amount = Math.round((remaining * qty) / left);
      if (
        !Number.isSafeInteger(p.value + amount) ||
        p.value + amount > 99999999999999
      )
        fail(400, "成本超出范围");
      p.quantity += qty;
      p.value += amount;
    } else {
      if (qty > p.quantity) fail(409, "配件库存不足");
      amount =
        qty === p.quantity ? p.value : Math.round((p.value * qty) / p.quantity);
      p.quantity -= qty;
      p.value -= amount;
    }
    p.version++;
    const row = {
      id: uid(),
      partId: p.id,
      orderId: o.id,
      kind: returning ? "return" : "issue",
      quantity: qty,
      cents: amount,
      issueId: returning ? issue.id : null,
      reason: d.reason,
      time: new Date().toISOString(),
    };
    ledger.unshift(row);
    return {
      data: {
        partId: p.id,
        issueId: returning ? issue.id : row.id,
        quantity: qty,
      },
      costData: { cost: amount / 100 },
    };
  }
  const routes = [
    [
      "GET",
      "/repair-orders/options",
      () => {
        requirePermission(
          PERM.REPAIR_HANDLE,
          PERM.REPAIR_QUOTE,
          PERM.REPAIR_CASH,
          PERM.PARTS_MANAGE,
        );
        return {
          canManageParts: has(PERM.PARTS_MANAGE) && cost(),
          engineers: [{ id: "mock_engineer", name: "维修工程师" }],
          passwordStorage: false,
          internalCostPolicy: "capitalize",
        };
      },
    ],
    [
      "GET",
      "/repair-orders/board",
      (d) => {
        const rows = filter(d).sort(
            (a, b) => closed(a.status) - closed(b.status),
          ),
          p = paginate(rows, { ...d, pageSize: 200 }),
          columns = Object.fromEntries(
            [...REPAIR_FLOW, "cancelled"].map((k) => [k, []]),
          );
        p.list.forEach((o) => columns[o.status].push(view(o)));
        return {
          columns,
          total: rows.length,
          page: p.page,
          pageSize: p.pageSize,
          hasMore: p.page * p.pageSize < rows.length,
        };
      },
    ],
    [
      "GET",
      "/repair-orders/stats",
      (d) => {
        read();
        const rows = filter(d),
          today = new Date(Date.now() + 28800000).toISOString().slice(0, 10),
          start = d.from
            ? Date.parse(d.from + "T00:00:00+08:00")
            : d.range === "month"
              ? Date.parse(today.slice(0, 8) + "01T00:00:00+08:00")
              : d.range === "week"
                ? Date.parse(today + "T00:00:00+08:00") -
                  ((new Date(Date.now() + 28800000).getUTCDay() + 6) % 7) *
                    86400000
                : Date.parse(today + "T00:00:00+08:00"),
          end = d.to
            ? Date.parse(d.to + "T00:00:00+08:00") + 86400000
            : Date.parse(today + "T00:00:00+08:00") + 86400000,
          inRange = (t) => Date.parse(t) >= start && Date.parse(t) < end,
          created = rows.filter((o) => inRange(o.createdAt)),
          completed = rows.filter(
            (o) => o.completedAt && inRange(o.completedAt),
          ),
          external = rows.filter((o) => o.kind === "external"),
          payments = external
            .flatMap((o) => o.payments)
            .filter((p) => inRange(p.time)),
          revenue =
            payments.reduce(
              (n, p) =>
                n +
                (p.kind === "receipt" ? 1 : p.kind === "refund" ? -1 : 0) *
                  p.cents,
              0,
            ) / 100,
          expenses =
            payments.reduce(
              (n, p) =>
                n +
                (p.kind === "expense"
                  ? 1
                  : p.kind === "expense_refund"
                    ? -1
                    : 0) *
                  p.cents,
              0,
            ) / 100,
          partCost =
            ledger
              .filter(
                (l) =>
                  external.some((o) => o.id === l.orderId) && inRange(l.time),
              )
              .reduce(
                (n, l) => n + (l.kind === "issue" ? 1 : -1) * l.cents,
                0,
              ) / 100;
        return {
          created: created.length,
          completed: completed.length,
          completionRate: created.length
            ? created.filter((o) => o.status === "completed").length /
              created.length
            : 0,
          avgHours: completed.length
            ? completed.reduce(
                (n, o) =>
                  n +
                  (Date.parse(o.completedAt) - Date.parse(o.createdAt)) /
                    3600000,
                0,
              ) / completed.length
            : 0,
          revenue,
          ...(cost()
            ? {
                partsCost: partCost,
                expenses,
                internalRepairCost:
                  Math.round(
                    rows
                      .filter(
                        (o) =>
                          o.costAllocation && inRange(o.costAllocation.time),
                      )
                      .reduce((n, o) => n + o.costAllocation.total_cost, 0) *
                      100,
                  ) / 100,
              }
            : {}),
          ...(profit()
            ? {
                profit: Math.round((revenue - partCost - expenses) * 100) / 100,
              }
            : {}),
          definition: "实际发生期收支；自有机维修成本单独归档。",
        };
      },
    ],
    ["GET", "/repair-orders", (d) => paginate(filter(d).map(view), d)],
    [
      "POST",
      "/repair-orders",
      (d) => {
        requirePermission(PERM.REPAIR_HANDLE);
        read();
        if (
          !d.requestKey ||
          !d.fault?.trim() ||
          Object.keys(d).some(
            (k) =>
              ![
                "requestKey",
                "kind",
                "unitId",
                "model",
                "identifier",
                "customer",
                "phone",
                "fault",
                "engineerId",
                "expectedAt",
                "photos",
              ].includes(k),
          )
        )
          fail(400, "请核对资料；不保存密码");
        const sig = signature({ actor: actor(), ...d }),
          prior = orders.find(
            (o) => o.creator === actor() && o.requestKey === d.requestKey,
          );
        if (prior) {
          if (prior.signature !== sig) fail(409, "提交标识内容冲突");
          return view(prior);
        }
        const kind = d.kind || "external",
          u =
            kind === "inventory"
              ? db.units.find((u) => u.id === d.unitId)
              : null;
        if (!["external", "inventory"].includes(kind)) fail(400, "来源无效");
        if (
          kind === "inventory" &&
          (!u ||
            u.status !== "in_stock" ||
            (u.ownership && u.ownership !== "own"))
        )
          fail(409, "设备不可送修");
        if (
          kind === "external" &&
          (!d.model || !d.customer || !isPhone(d.phone))
        )
          fail(400, "请填写型号/联系人/电话");
        const identifier = u
          ? u.imei1
          : String(d.identifier || "").toUpperCase();
        if (
          /^\d{15}$/.test(identifier) &&
          !isImei(identifier) &&
          kind === "external"
        )
          fail(400, "IMEI校验位无效");
        if (
          kind === "external" &&
          identifier &&
          (orders.some(
            (o) => o.identifier === identifier && !closed(o.status),
          ) ||
            db.units.some(
              (u) =>
                [u.imei1, u.imei2].includes(identifier) &&
                !["sold", "returned"].includes(u.status),
            ))
        )
          fail(409, "串码已在业务中");
        const engineerId = has(PERM.REPAIR_ASSIGN)
          ? d.engineerId || null
          : actor();
        if (
          !has(PERM.REPAIR_ASSIGN) &&
          d.engineerId &&
          d.engineerId !== actor()
        )
          fail(403, "不能分派他人");
        const photos = images(d.photos),
          time = new Date().toISOString(),
          o = {
            id: uid(),
            no: "RO" + uid(),
            kind,
            unitId: u?.id || null,
            model: u ? u.name : d.model,
            identifier,
            customer: kind === "external" ? d.customer : "",
            phone: kind === "external" ? d.phone : "",
            fault: d.fault,
            engineerId,
            expectedAt: d.expectedAt || null,
            status: "pending_check",
            version: 1,
            diagnosis: "",
            quote: null,
            quoteVersion: 0,
            confirmedVersion: null,
            waitingParts: false,
            pickupName: "",
            warrantyDays: null,
            createdAt: time,
            completedAt: null,
            files: [],
            payments: [],
            timeline: [],
            operations: {},
            creator: actor(),
            requestKey: d.requestKey,
            signature: sig,
          };
        attach(o, photos, "appearance");
        if (u) {
          u.status = "repairing";
          u.flags = { showInShop: false, sharePeer: false, shareAgent: false };
          db.inventoryLedger = db.inventoryLedger || [];
          db.inventoryLedger.unshift({
            id: uid(),
            unitId: u.id,
            from: "in_stock",
            to: "repairing",
            docType: "repair_order",
            doc: o.id,
            operator: currentRole(),
            time,
          });
        }
        orders.unshift(o);
        o.timeline.push({
          id: uid(),
          action: "create",
          from: o.status,
          to: o.status,
          version: 1,
          note: "创建维修单",
          time,
          operator: currentRole(),
          data: { kind },
        });
        audit("创建维修单", o.id, "");
        return view(o);
      },
    ],
    ["GET", "/repair-orders/:id", (d, h, p) => view(find(p.id))],
    [
      "PUT",
      "/repair-orders/:id",
      (d, h, p) =>
        mutate(d, p, "update", write, (o) => {
          if (closed(o.status)) fail(409, "已结束");
          if (d.engineerId !== undefined) {
            requirePermission(PERM.REPAIR_ASSIGN);
            if (d.engineerId && d.engineerId !== "mock_engineer")
              fail(400, "工程师无效");
          }
          if (d.customer !== undefined || d.phone !== undefined) {
            requirePermission(PERM.REPAIR_ASSIGN);
            if (
              o.kind !== "external" ||
              (d.customer !== undefined && !d.customer?.trim()) ||
              (d.phone !== undefined && !isPhone(d.phone))
            )
              fail(400, "联系资料无效");
          }
          if (
            d.waitingParts !== undefined &&
            typeof d.waitingParts !== "boolean"
          )
            fail(400, "标记无效");
          if (
            ![
              "customer",
              "phone",
              "engineerId",
              "expectedAt",
              "diagnosis",
              "waitingParts",
              "fault",
            ].some((k) => d[k] !== undefined) &&
            !d.photos?.length
          )
            fail(400, "没有改动");
          if (d.diagnosis !== undefined && !d.diagnosis.trim())
            fail(400, "检测结果必填");
          const files = images(d.photos);
          for (const k of [
            "customer",
            "phone",
            "engineerId",
            "expectedAt",
            "diagnosis",
            "waitingParts",
            "fault",
          ])
            if (d[k] !== undefined) o[k] = d[k];
          attach(o, files, "appearance");
          return {
            data: { diagnosis: o.diagnosis, waitingParts: o.waitingParts },
          };
        }),
    ],
    [
      "POST",
      "/repair-orders/:id/quote",
      (d, h, p) =>
        mutate(
          d,
          p,
          "quote",
          (o) => {
            read(o);
            requirePermission(PERM.REPAIR_QUOTE);
          },
          (o) => {
            if (!["checking", "pending_confirm"].includes(o.status))
              fail(409, "当前节点不能报价");
            const amount = cents(d.amount);
            if (amount < totals(o).received) fail(400, "报价低于已收款");
            o.quote = amount;
            o.quoteVersion++;
            o.confirmedVersion = null;
            return {
              data: { quote: amount / 100, quoteVersion: o.quoteVersion },
            };
          },
        ),
    ],
    [
      "POST",
      "/repair-orders/:id/confirm",
      (d, h, p) =>
        mutate(d, p, "confirm", write, (o) => {
          if (o.kind === "inventory") requirePermission(PERM.REPAIR_ASSIGN);
          if (
            o.status !== "pending_confirm" ||
            o.quote === null ||
            d.confirmed !== true ||
            d.quoteVersion !== o.quoteVersion
          )
            fail(409, "报价版本未确认");
          o.confirmedVersion = o.quoteVersion;
          return { data: { confirmed: true, quoteVersion: o.quoteVersion } };
        }),
    ],
    [
      "POST",
      "/repair-orders/:id/parts/issue",
      (d, h, p) => mutate(d, p, "issue", write, (o) => move(o, d, false)),
    ],
    [
      "POST",
      "/repair-orders/:id/parts/return",
      (d, h, p) => mutate(d, p, "return_parts", write, (o) => move(o, d, true)),
    ],
    [
      "POST",
      "/repair-orders/:id/payment",
      (d, h, p) =>
        mutate(d, p, "payment", cash, (o) => {
          if (
            !["receipt", "refund", "expense", "expense_refund"].includes(
              d.kind,
            ) ||
            d.confirmed !== true ||
            !["微信", "支付宝", "现金", "银行卡", "其他"].includes(d.method)
          )
            fail(400, "请确认实际办理");
          const amount = cents(d.amount),
            t = totals(o);
          if (!amount) fail(400, "金额须大于零");
          if (d.kind.includes("refund")) requirePermission(PERM.REFUND);
          if (d.kind.startsWith("expense")) {
            if (!cost()) fail(403, "无成本权限");
            if (o.kind === "inventory" && closed(o.status)) fail(409, "已归档");
            if (d.kind === "expense_refund" && amount > t.expenses)
              fail(400, "超过费用");
          } else {
            if (o.kind !== "external") fail(400, "本店机不对客收款");
            if (
              (d.kind === "receipt" &&
                (o.quote === null ||
                  o.status === "cancelled" ||
                  t.received + amount > o.quote)) ||
              (d.kind === "refund" && amount > t.received)
            )
              fail(400, "超过报价或可退金额");
          }
          const proof = images(d.proof);
          o.payments.push({
            id: uid(),
            kind: d.kind,
            cents: amount,
            method: d.method,
            reason: d.reason,
            time: new Date().toISOString(),
          });
          attach(
            o,
            proof,
            d.kind.startsWith("expense") ? "expense" : "payment",
          );
          return d.kind.startsWith("expense")
            ? { data: { kind: d.kind }, costData: { amount: amount / 100 } }
            : { data: { kind: d.kind, amount: amount / 100 } };
        }),
    ],
    [
      "POST",
      "/repair-orders/:id/transition",
      (d, h, p) =>
        mutate(d, p, "transition", write, (o) => {
          if (!(TRANSITIONS[o.status] || []).includes(d.to))
            fail(409, "不允许跨节点");
          if (d.to === "pending_confirm" && (!o.diagnosis || o.quote === null))
            fail(400, "请先检测并报价");
          if (
            d.to === "repairing" &&
            (o.quote === null || o.confirmedVersion !== o.quoteVersion)
          )
            fail(409, "尚未确认当前报价");
          if (
            d.to === "pending_pickup" &&
            (o.waitingParts || !d.result?.trim())
          )
            fail(400, "请确认配件齐备并填写结果");
          const t = totals(o);
          let proof = [];
          if (d.to === "completed") {
            if (!d.pickupName?.trim()) fail(400, "请填写取机人");
            proof = images(d.pickupProof);
            if (
              !proof.length ||
              (o.kind === "external" && t.received !== o.quote)
            )
              fail(409, "请结清并上传凭证");
            number(d.warrantyDays, 0, 3650);
          }
          if (d.to === "cancelled" && (t.received !== 0 || t.parts !== 0))
            fail(409, "先退清收款与配件");
          if (closed(d.to)) finish(o);
          if (o.status === "pending_confirm" && d.to === "checking")
            o.confirmedVersion = null;
          o.status = d.to;
          if (d.to === "completed") {
            o.pickupName = d.pickupName;
            o.warrantyDays = Number(d.warrantyDays);
            o.completedAt = new Date().toISOString();
            attach(o, proof, "pickup");
          }
          return { data: { to: d.to, result: d.result || "" } };
        }),
    ],
    [
      "GET",
      "/repair-parts",
      (d) => {
        requirePermission(
          PERM.REPAIR_HANDLE,
          PERM.REPAIR_CASH,
          PERM.PARTS_MANAGE,
        );
        return paginate(
          parts
            .filter((p) => !d.keyword || (p.name + p.sku).includes(d.keyword))
            .map(partView),
          d,
        );
      },
    ],
    [
      "POST",
      "/repair-parts",
      (d) => {
        partManage();
        if (!d.sku || !d.name) fail(400, "SKU和名称必填");
        const old = parts.find((p) => p.sku === d.sku);
        if (old) {
          if (old.name !== d.name || old.unit !== (d.unit || "件"))
            fail(409, "SKU已存在");
          return partView(old);
        }
        const p = {
          id: uid(),
          sku: d.sku,
          name: d.name,
          unit: d.unit || "件",
          quantity: 0,
          value: 0,
          version: 1,
          operations: {},
        };
        parts.push(p);
        audit("新增维修配件", p.id, "");
        return partView(p);
      },
    ],
    [
      "POST",
      "/repair-parts/:id/receive",
      (d, h, path) => {
        partManage();
        const p =
            parts.find((p) => p.id === path.id) || fail(404, "配件不存在"),
          sig = signature(d),
          op = actor() + ":" + d.requestKey;
        if (!d.requestKey || !d.reason) fail(400, "请填写标识和说明");
        if (p.operations[op]) {
          if (p.operations[op] !== sig) fail(409, "标识冲突");
          return partView(p);
        }
        if (d.version !== p.version) fail(409, "版本已变化");
        const qty = number(d.quantity),
          price = cents(d.unitCost);
        if (p.quantity + qty > 1000000) fail(400, "数量超出范围");
        if (
          !Number.isSafeInteger(p.value + qty * price) ||
          p.value + qty * price > 99999999999999
        )
          fail(400, "金额超出范围");
        p.quantity += qty;
        p.value += qty * price;
        p.version++;
        p.operations[op] = sig;
        ledger.unshift({
          id: uid(),
          partId: p.id,
          kind: "receive",
          quantity: qty,
          cents: qty * price,
          reason: d.reason,
          time: new Date().toISOString(),
        });
        audit("维修配件入库", p.id, d.reason);
        return partView(p);
      },
    ],
    [
      "GET",
      "/repair-parts/:id/ledger",
      (d, h, p) => {
        requirePermission(
          PERM.REPAIR_HANDLE,
          PERM.REPAIR_CASH,
          PERM.PARTS_MANAGE,
        );
        return paginate(
          ledger
            .filter((l) => l.partId === p.id)
            .map((l) => ({
              id: l.id,
              kind: l.kind,
              quantity: l.quantity,
              time: l.time,
              ...([
                PERM.REPAIR_ASSIGN,
                PERM.REPAIR_CASH,
                PERM.PARTS_MANAGE,
              ].some(has) ||
              orders.some((o) => o.id === l.orderId && o.engineerId === actor())
                ? { orderId: l.orderId, issueId: l.issueId, reason: l.reason }
                : {}),
              ...(cost() ? { cost: l.cents / 100 } : {}),
            })),
          d,
        );
      },
    ],
  ];
  return {
    routes,
    canReadFile,
    stats: (d = {}) =>
      routes.find((r) => r[0] === "GET" && r[1] === "/repair-orders/stats")[2](
        d,
      ),
    queue: () => {
      const rows = filter({}).filter((o) => !closed(o.status)),
        today = new Date(Date.now() + 28800000).toISOString().slice(0, 10);
      return {
        overdue: rows.filter((o) => o.expectedAt && o.expectedAt < today)
          .length,
        pendingConfirm: rows.filter((o) => o.status === "pending_confirm")
          .length,
        waitingParts: rows.filter((o) => o.waitingParts).length,
      };
    },
  };
};
