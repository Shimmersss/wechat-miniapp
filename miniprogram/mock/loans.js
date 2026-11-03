const {
  PERM,
  ROLE_PERMISSIONS,
  SENSITIVE_FIELDS,
} = require("../constants/roles");
const { isImei, isPhone } = require("../utils/validate");
module.exports = function (
  db,
  { fail, currentRole, requirePermission, paginate, clone, uploadedFiles },
) {
  const orders = (db.loanTransactions = db.loanTransactions || []);
  db.inventoryLedger = db.inventoryLedger || [];
  let seq = 0;
  const uid = () => "loan_" + Date.now() + "_" + ++seq,
    read = () => requirePermission(PERM.LOAN_MANAGE),
    today = () => new Date(Date.now() + 28800000).toISOString().slice(0, 10),
    has = (p) => (ROLE_PERMISSIONS[currentRole()] || []).includes(p),
    signature = (v) => JSON.stringify(canonical(v));
  function canonical(v) {
    return Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, canonical(v[k])]),
          )
        : v;
  }
  function keys(d, allowed) {
    if (
      !d ||
      Array.isArray(d) ||
      Object.keys(d).some((k) => !allowed.includes(k))
    )
      fail(400, "借还参数无效");
  }
  function charges(d) {
    for (const k of ["deposit", "overdueFee", "compensation"])
      if (
        d[k] !== undefined &&
        d[k] !== null &&
        d[k] !== "" &&
        Number(d[k]) !== 0
      )
        fail(400, "首期不收押金、逾期费与损坏赔偿，请勿填写金额");
  }
  function text(v, label, max = 500, optional = false) {
    if (typeof v !== "string" || v.length > max || (!optional && !v.trim()))
      fail(400, "请核对" + label);
    return v.trim();
  }
  const get = (id) =>
      orders.find((o) => o.id === id) || fail(404, "借还单不存在"),
    unit = (id) => db.units.find((u) => u.id === id) || fail(404, "设备不存在");
  function canReadFile(id) {
    if (!orders.some((o) => o.photos.some((f) => f.fileId === id)))
      return undefined;
    return has(PERM.LOAN_MANAGE);
  }
  function photos(values = [], required = false) {
    if (
      !Array.isArray(values) ||
      values.length > 9 ||
      (required && !values.length)
    )
      fail(400, "请上传1～9张内部交接图片");
    const ids = new Set();
    return values.map((v) => {
      const f = uploadedFiles.get(v?.fileId) || fail(400, "凭证不存在");
      if (ids.has(f.fileId) || f.scope !== "internal")
        fail(400, "凭证重复或范围无效");
      ids.add(f.fileId);
      if (
        !["boss", "manager"].includes(currentRole()) &&
        f.ownerRole !== currentRole()
      )
        fail(403, "不能引用他人凭证");
      if (
        (db.repairTransactions || []).some((o) =>
          o.files.some((v) => v.fileId === f.fileId),
        ) ||
        db.units.some((u) =>
          [
            ...(u.receiptImages || []),
            ...Object.values(u.attributes || {})
              .filter(Array.isArray)
              .flat(),
          ].some((v) => v?.fileId === f.fileId),
        )
      )
        fail(400, "其他业务凭证不能用于借还");
      return { fileId: f.fileId, url: f.url, scope: "internal" };
    });
  }
  function ledger(u, from, to, type, o, reason) {
    const entry = {
      id: uid(),
      unitId: u.id,
      from,
      to,
      docType: type,
      doc: o.id,
      operator: currentRole(),
      time: new Date().toISOString(),
      reason,
    };
    db.inventoryLedger.unshift(entry);
    return entry.id;
  }
  function view(o) {
    read();
    const out = clone(o);
    for (const k of ["creator", "requestKey", "hash", "operations"])
      delete out[k];
    out.storedStatus = o.status;
    out.overdue =
      o.status === "active" &&
      o.dueAt < today() &&
      o.items.some((i) => i.status === "active");
    out.status = out.overdue ? "overdue" : o.status;
    out.items = out.items.map((i) => {
      const u = unit(i.unitId);
      delete i.returnLedger;
      return {
        ...i,
        unitStatus: u.status,
        imeiMasked: i.imei1.slice(0, 2) + "****" + i.imei1.slice(-4),
        imei1: SENSITIVE_FIELDS.fullImei.includes(currentRole())
          ? i.imei1
          : undefined,
        imei2: SENSITIVE_FIELDS.fullImei.includes(currentRole())
          ? i.imei2
          : undefined,
        canRecheck:
          i.status === "returned_recheck" &&
          has(PERM.ACCEPTANCE) &&
          has(PERM.INVENTORY_VIEW),
      };
    });
    return { ...out, financialPolicy: "none", supportsPayments: false };
  }
  function atomic(fn) {
    const us = clone(db.units),
      os = clone(orders),
      ls = clone(db.inventoryLedger);
    try {
      return fn();
    } catch (e) {
      db.units.splice(0, db.units.length, ...us);
      orders.splice(0, orders.length, ...os);
      db.inventoryLedger.splice(0, db.inventoryLedger.length, ...ls);
      throw e;
    }
  }
  function event(o, action, d, data, files = []) {
    const e = {
      id: uid(),
      action,
      version: o.version,
      reason: d.reason,
      data,
      time: new Date().toISOString(),
      operator: currentRole(),
    };
    o.timeline.push(e);
    files.forEach((f) => o.photos.push({ ...f, eventId: e.id }));
    db.auditLogs.unshift({
      id: uid(),
      action: "借还:" + action,
      detail: o.id,
      operator: currentRole(),
      time: e.time,
      reason: d.reason,
    });
  }
  function mutate(d, p, action, extra, fn) {
    read();
    keys(d, ["requestKey", "version", "reason", ...extra]);
    text(d.requestKey, "操作标识", 100);
    text(d.reason, "处理说明");
    const o = get(p.id),
      hash = signature({ actor: currentRole(), action, ...d });
    if (o.operations[d.requestKey]) {
      if (o.operations[d.requestKey] !== hash) fail(409, "操作标识内容冲突");
      return view(o);
    }
    if (o.version !== d.version || o.status === "closed")
      fail(409, "借还单版本或状态已变化");
    return atomic(() => {
      const result = fn(o);
      o.status = o.items.every((i) => i.status === "closed")
        ? "closed"
        : o.items.some((i) => i.status === "active")
          ? "active"
          : "returned_recheck";
      o.version++;
      o.operations[d.requestKey] = hash;
      event(o, action, d, result.data, result.photos);
      return view(o);
    });
  }
  const routes = [
    [
      "GET",
      "/loans/options",
      () => {
        read();
        return {
          financialPolicy: "none",
          supportsPayments: false,
          borrowedSalesEnabled: false,
          maxItems: 50,
        };
      },
    ],
    [
      "POST",
      "/loans",
      (d) => {
        read();
        keys(d, [
          "requestKey",
          "type",
          "unitIds",
          "devices",
          "counterparty",
          "phone",
          "dueAt",
          "remark",
          "reason",
          "photos",
          "deposit",
          "overdueFee",
          "compensation",
        ]);
        charges(d);
        text(d.requestKey, "提交标识", 100);
        text(d.counterparty, "对方", 120);
        text(d.reason, "交接说明");
        if (
          !isPhone(d.phone) ||
          !/^\d{4}-\d{2}-\d{2}$/.test(d.dueAt) ||
          !Number.isFinite(Date.parse(d.dueAt + "T00:00:00+08:00")) ||
          !["loan_out", "borrow_in"].includes(d.type)
        )
          fail(400, "请核对类型/电话/日期");
        const input = d.type === "loan_out" ? d.unitIds : d.devices;
        if (
          !Array.isArray(input) ||
          !input.length ||
          input.length > 50 ||
          (d.type === "loan_out" && d.devices !== undefined) ||
          (d.type === "borrow_in" && d.unitIds !== undefined)
        )
          fail(400, "请按类型填写1～50台设备");
        const hash = signature({ actor: currentRole(), ...d }),
          old = orders.find(
            (o) => o.creator === currentRole() && o.requestKey === d.requestKey,
          );
        if (old) {
          if (old.hash !== hash) fail(409, "提交内容冲突");
          return view(old);
        }
        return atomic(() => {
          const files = photos(d.photos),
            o = {
              id: uid(),
              no: "LN" + uid(),
              type: d.type,
              counterparty: d.counterparty,
              phone: d.phone,
              dueAt: d.dueAt,
              remark: d.remark || "",
              status: "active",
              version: 1,
              createdAt: new Date().toISOString(),
              creator: currentRole(),
              requestKey: d.requestKey,
              hash,
              operations: {},
              items: [],
              photos: [],
              timeline: [],
            },
            seen = new Set();
          for (const v of input) {
            let u;
            if (d.type === "loan_out") {
              requirePermission(PERM.INVENTORY_VIEW);
              if (seen.has(v)) fail(400, "设备重复");
              seen.add(v);
              u = unit(v);
              if (
                u.status !== "in_stock" ||
                (u.ownership && u.ownership !== "own") ||
                orders.some((o) =>
                  o.items.some(
                    (i) => i.unitId === u.id && i.status !== "closed",
                  ),
                )
              )
                fail(409, "设备不可出借");
              u.status = "loaned_out";
              u.flags = {
                showInShop: false,
                sharePeer: false,
                shareAgent: false,
              };
              ledger(u, "in_stock", "loaned_out", "loan_out", o, d.reason);
            } else {
              keys(v, [
                "modelId",
                "imei1",
                "imei2",
                "condition",
                "description",
              ]);
              const m =
                db.models.find((m) => m.id === v.modelId) ||
                fail(400, "型号不存在");
              for (const code of [v.imei1, v.imei2].filter(Boolean)) {
                if (!isImei(code) || seen.has(code))
                  fail(400, "串码无效或重复");
                seen.add(code);
                if (
                  (db.repairTransactions || []).some(
                    (o) =>
                      o.identifier === code &&
                      !["completed", "cancelled"].includes(o.status),
                  )
                )
                  fail(409, "设备正在外部维修");
              }
              u = db.units.find((u) =>
                [u.imei1, u.imei2].some(
                  (code) => code && [v.imei1, v.imei2].includes(code),
                ),
              );
              if (u) {
                if (
                  u.status !== "returned" ||
                  u.ownership !== "borrowed" ||
                  u.modelId !== v.modelId ||
                  u.imei1 !== v.imei1 ||
                  (u.imei2 || "") !== (v.imei2 || "")
                )
                  fail(409, "串码已用于其他业务");
                u.status = "borrowed_in";
              } else {
                u = {
                  id: uid(),
                  name: m.name,
                  modelId: m.id,
                  imei1: v.imei1,
                  imei2: v.imei2 || "",
                  ownership: "borrowed",
                  status: "borrowed_in",
                  condition: v.condition || "used",
                  cost: 0,
                  retail: 0,
                  wholesale: 0,
                  agentBase: 0,
                  flags: {
                    showInShop: false,
                    sharePeer: false,
                    shareAgent: false,
                  },
                  attributes: {},
                  templateSnapshot: { fields: [] },
                  images: [],
                  ageDays: 0,
                };
                db.units.push(u);
              }
              ledger(u, null, "borrowed_in", "borrow_in", o, d.reason);
            }
            o.items.push({
              id: uid(),
              unitId: u.id,
              modelId: u.modelId,
              name: u.name,
              imei1: u.imei1,
              imei2: u.imei2 || "",
              ownership: d.type === "loan_out" ? "own" : "borrowed",
              status: "active",
            });
          }
          orders.unshift(o);
          event(o, "create", d, { type: o.type, count: o.items.length }, files);
          return view(o);
        });
      },
    ],
    [
      "POST",
      "/loans/:id/return",
      (d, h, p) =>
        mutate(d, p, "return", ["items"], (o) => {
          if (!Array.isArray(d.items) || !d.items.length || d.items.length > 50)
            fail(400, "请选择逐台归还设备");
          const seen = new Set(),
            files = [],
            items = [];
          for (const v of d.items) {
            keys(v, ["unitId", "condition", "damage", "photos"]);
            if (seen.has(v.unitId)) fail(400, "设备重复");
            seen.add(v.unitId);
            const i = o.items.find((i) => i.unitId === v.unitId);
            if (!i || i.status !== "active")
              fail(409, "设备不在本单待归还列表");
            text(v.condition, "归还检查", 2000);
            text(v.damage || "", "损坏描述", 2000, true);
            files.push(...photos(v.photos, true));
            const u = unit(i.unitId),
              from = o.type === "loan_out" ? "loaned_out" : "borrowed_in",
              to = o.type === "loan_out" ? "recheck" : "returned";
            if (u.status !== from) fail(409, "设备状态已变化");
            u.status = to;
            u.flags = {
              showInShop: false,
              sharePeer: false,
              shareAgent: false,
            };
            i.status = o.type === "loan_out" ? "returned_recheck" : "closed";
            i.returnedAt = new Date().toISOString();
            i.returnLedger = ledger(
              u,
              from,
              to,
              o.type === "loan_out" ? "loan_return" : "borrow_return",
              o,
              d.reason,
            );
            items.push({
              unitId: u.id,
              condition: v.condition,
              damage: v.damage || "",
              next: to,
            });
          }
          return {
            data: { items },
            photos: [...new Map(files.map((f) => [f.fileId, f])).values()],
          };
        }),
    ],
    [
      "POST",
      "/loans/:id/recheck",
      (d, h, p) =>
        mutate(d, p, "recheck", ["unitIds"], (o) => {
          if (
            o.type !== "loan_out" ||
            !Array.isArray(d.unitIds) ||
            !d.unitIds.length ||
            d.unitIds.length > 50 ||
            new Set(d.unitIds).size !== d.unitIds.length
          )
            fail(400, "请选择已实际通过复检设备");
          for (const target of d.unitIds) {
            const i = o.items.find((i) => i.unitId === target);
            if (!i || i.status !== "returned_recheck")
              fail(409, "设备未处于归还待复检");
            const ledger = db.inventoryLedger,
              index = ledger.findIndex((l) => l.id === i.returnLedger);
            if (
              index < 0 ||
              !ledger
                .slice(0, index)
                .some(
                  (l) =>
                    l.unitId === target &&
                    l.docType === "recheck" &&
                    l.to === "in_stock",
                )
            )
              fail(409, "须先在库存页实际复检通过");
            i.status = "closed";
          }
          return { data: { unitIds: d.unitIds }, photos: [] };
        }),
    ],
    [
      "GET",
      "/loans",
      (d) => {
        read();
        let rows = orders;
        if (d.type) rows = rows.filter((o) => o.type === d.type);
        if (d.status)
          rows = rows.filter((o) =>
            d.status === "overdue"
              ? view(o).overdue
              : d.status === "returned_recheck"
                ? o.items.some((i) => i.status === "returned_recheck")
                : o.status === d.status,
          );
        if (d.keyword)
          rows = rows.filter(
            (o) =>
              (o.no + o.counterparty).includes(d.keyword) ||
              o.items.some((i) => [i.imei1, i.imei2].includes(d.keyword)),
          );
        return paginate(rows.map(view), d);
      },
    ],
    [
      "GET",
      "/loans/:id",
      (d, h, p) => {
        read();
        return view(get(p.id));
      },
    ],
  ];
  return { routes, canReadFile };
};
