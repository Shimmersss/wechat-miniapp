const { transaction, one } = require("./db");
const {
  PERM,
  ROLE_LABELS,
  STAFF_ROLES,
  SENSITIVE_FIELDS,
  fail,
  text,
  id,
  json,
  page,
  list,
  requirePerm,
  audit,
} = require("./core");
const { canSee } = require("./stock");
const { isPhone } = require("../../miniprogram/utils/validate");

/**
 * 员工与权限（框架文档 需求 1/2、二）：员工增改/停用/解绑微信、角色权限点与敏感字段可见性、操作日志查询。
 * 老板角色固定为全部权限且不可编辑；非老板不能创建、修改老板账号或授予老板角色；任何人不能停用或降级自己；
 * 至少保留一名在职老板。所有变更须填写原因并写审计，停用/解绑立即使其会话失效。
 */
module.exports = async function (app, { pool, route }) {
  const ALL_PERMS = new Set(Object.values(PERM)),
    FIELDS = Object.keys(SENSITIVE_FIELDS);
  const manager = (r) => {
    requirePerm(r, PERM.STAFF_MANAGE);
    if (!r.user.staffNo) fail(403, "仅员工可操作");
  };
  const owner = (r) => {
    manager(r);
    if (r.user.role !== "boss") fail(403, "仅老板可调整角色权限");
  };
  const reasonOf = (d) => text(d.reason, "调整原因", 500);
  const SELECT = `SELECT s.*,u.nickname,(SELECT MAX(created_at) FROM sessions x WHERE x.user_id=s.user_id) last_login FROM staff s LEFT JOIN users u ON u.id=s.user_id`;
  function view(row, r) {
    return {
      id: row.id,
      isSelf: !!row.user_id && row.user_id === r?.user.id,
      name: row.name,
      phone: row.phone,
      roleKey: row.role_key,
      roleLabel: ROLE_LABELS[row.role_key] || row.role_key,
      status: row.status,
      wechatBound: !!row.user_id,
      lastLoginAt: row.last_login || null,
      createdAt: row.created_at,
      version: row.version,
    };
  }
  async function bosses(db) {
    return Number(
      (
        await one(
          db,
          "SELECT COUNT(*) n FROM staff WHERE role_key='boss' AND status='active'",
        )
      ).n,
    );
  }

  // ---------- 员工 ----------
  route("GET", "/staff", async (r) => {
    manager(r);
    const p = page(r.query),
      args = [],
      where = [];
    if (r.query.status) {
      if (!["active", "disabled"].includes(r.query.status))
        fail(400, "员工状态无效");
      where.push("s.status=?");
      args.push(r.query.status);
    }
    if (r.query.roleKey) {
      where.push("s.role_key=?");
      args.push(text(r.query.roleKey, "角色", 32));
    }
    if (r.query.keyword) {
      const k = "%" + text(r.query.keyword, "搜索", 50) + "%";
      where.push("(s.name LIKE ? OR s.phone LIKE ?)");
      args.push(k, k);
    }
    const clause = where.length ? " WHERE " + where.join(" AND ") : "",
      count = await one(pool, "SELECT COUNT(*) n FROM staff s" + clause, args),
      [rows] = await pool.query(
        SELECT +
          clause +
          " ORDER BY s.status,s.role_key='boss' DESC,s.created_at,s.id LIMIT ? OFFSET ?",
        [...args, p.pageSize, p.offset],
      );
    return list(
      rows.map((row) => view(row, r)),
      count.n,
      p,
    );
  });
  route("POST", "/staff", async (r) => {
    manager(r);
    const d = r.body || {};
    if (
      Object.keys(d).some(
        (k) => !["name", "phone", "roleKey", "reason"].includes(k),
      )
    )
      fail(400, "员工参数无效");
    const name = text(d.name, "姓名", 50),
      phone = text(d.phone, "手机号", 11),
      roleKey = text(d.roleKey, "角色", 32),
      reason = reasonOf(d);
    if (!isPhone(phone)) fail(400, "请填写11位手机号");
    if (!STAFF_ROLES.includes(roleKey)) fail(400, "角色无效");
    if (roleKey === "boss" && r.user.role !== "boss")
      fail(403, "仅老板可添加老板账号");
    return transaction(pool, async (db) => {
      if (
        await one(db, "SELECT id FROM staff WHERE phone=? FOR UPDATE", [phone])
      )
        fail(409, "该手机号已是员工");
      const target = id();
      await db.execute(
        "INSERT INTO staff(id,phone,name,role_key) VALUES (?,?,?,?)",
        [target, phone, name, roleKey],
      );
      await audit(db, r, "新增员工", target, {
        after: { name, roleKey },
        reason,
      });
      return view(await one(db, SELECT + " WHERE s.id=?", [target]), r);
    });
  });
  route("PATCH", "/staff/:id", async (r) => {
    manager(r);
    const d = r.body || {};
    if (
      Object.keys(d).some(
        (k) => !["name", "roleKey", "status", "reason", "version"].includes(k),
      )
    )
      fail(400, "员工参数无效");
    const reason = reasonOf(d),
      name = d.name === undefined ? null : text(d.name, "姓名", 50);
    if (d.roleKey !== undefined && !STAFF_ROLES.includes(d.roleKey))
      fail(400, "角色无效");
    if (d.status !== undefined && !["active", "disabled"].includes(d.status))
      fail(400, "员工状态无效");
    return transaction(pool, async (db) => {
      const row = await one(db, "SELECT * FROM staff WHERE id=? FOR UPDATE", [
        r.params.id,
      ]);
      if (!row) fail(404, "员工不存在");
      if (row.version !== Number(d.version))
        fail(409, "员工资料已更新，请刷新");
      const roleKey = d.roleKey ?? row.role_key,
        status = d.status ?? row.status;
      if (
        r.user.role !== "boss" &&
        (row.role_key === "boss" || roleKey === "boss")
      )
        fail(403, "仅老板可修改老板账号或授予老板角色");
      if (
        row.user_id === r.user.id &&
        (roleKey !== row.role_key || status !== "active")
      )
        fail(400, "不能停用或更改自己的角色");
      if (
        row.role_key === "boss" &&
        row.status === "active" &&
        (roleKey !== "boss" || status !== "active") &&
        (await bosses(db)) <= 1
      )
        fail(409, "至少保留一名在职老板");
      await db.execute(
        "UPDATE staff SET name=COALESCE(?,name),role_key=?,status=?,version=version+1 WHERE id=?",
        [name, roleKey, status, row.id],
      );
      if (status !== "active" && row.user_id)
        await db.execute("DELETE FROM sessions WHERE user_id=?", [row.user_id]);
      await audit(
        db,
        r,
        status !== row.status
          ? status === "active"
            ? "恢复员工"
            : "停用员工"
          : "调整员工资料或角色",
        row.id,
        {
          before: { name: row.name, roleKey: row.role_key, status: row.status },
          after: { name: name ?? row.name, roleKey, status },
          reason,
        },
      );
      return view(await one(db, SELECT + " WHERE s.id=?", [row.id]), r);
    });
  });
  route("POST", "/staff/:id/unbind", async (r) => {
    manager(r);
    const d = r.body || {},
      reason = reasonOf(d);
    return transaction(pool, async (db) => {
      const row = await one(db, "SELECT * FROM staff WHERE id=? FOR UPDATE", [
        r.params.id,
      ]);
      if (!row) fail(404, "员工不存在");
      if (row.version !== Number(d.version))
        fail(409, "员工资料已更新，请刷新");
      if (!row.user_id) fail(409, "该员工尚未绑定微信");
      if (row.user_id === r.user.id) fail(400, "不能解绑自己的微信");
      if (row.role_key === "boss" && r.user.role !== "boss")
        fail(403, "仅老板可解绑老板账号");
      await db.execute(
        "UPDATE staff SET user_id=NULL,version=version+1 WHERE id=?",
        [row.id],
      );
      await db.execute("DELETE FROM sessions WHERE user_id=?", [row.user_id]);
      await audit(db, r, "解绑员工微信", row.id, {
        before: { wechatBound: true },
        after: { wechatBound: false },
        reason,
      });
      return view(await one(db, SELECT + " WHERE s.id=?", [row.id]), r);
    });
  });

  // ---------- 角色权限与字段可见性 ----------
  function roleView(row, count) {
    const boss = row.role_key === "boss";
    return {
      key: row.role_key,
      label: row.label,
      permissions: boss ? [...ALL_PERMS] : json(row.permissions) || [],
      visibleFields: boss ? FIELDS : json(row.visible_fields) || [],
      editable: !boss,
      staffCount: Number(count || 0),
      version: row.version,
    };
  }
  route("GET", "/roles", async (r) => {
    manager(r);
    const [rows] = await pool.execute(
        "SELECT * FROM roles WHERE role_key IN (" +
          STAFF_ROLES.map(() => "?").join(",") +
          ")",
        STAFF_ROLES,
      ),
      [counts] = await pool.execute(
        "SELECT role_key,COUNT(*) n FROM staff WHERE status='active' GROUP BY role_key",
      );
    return {
      list: STAFF_ROLES.map((k) => rows.find((x) => x.role_key === k))
        .filter(Boolean)
        .map((row) =>
          roleView(row, counts.find((c) => c.role_key === row.role_key)?.n),
        ),
      canEdit: r.user.role === "boss",
    };
  });
  route("PUT", "/roles/:key", async (r) => {
    owner(r);
    const d = r.body || {},
      reason = reasonOf(d),
      key = r.params.key;
    if (!STAFF_ROLES.includes(key)) fail(404, "角色不存在");
    if (key === "boss") fail(400, "老板角色固定拥有全部权限，不能编辑");
    if (
      !Array.isArray(d.permissions) ||
      d.permissions.some((p) => !ALL_PERMS.has(p)) ||
      !Array.isArray(d.visibleFields) ||
      d.visibleFields.some((f) => !FIELDS.includes(f))
    )
      fail(400, "权限点或字段无效");
    const permissions = [...new Set(d.permissions)].sort(),
      fields = [...new Set(d.visibleFields)].sort();
    return transaction(pool, async (db) => {
      const row = await one(
        db,
        "SELECT * FROM roles WHERE role_key=? FOR UPDATE",
        [key],
      );
      if (!row) fail(404, "角色不存在");
      if (row.version !== Number(d.version))
        fail(409, "角色已被他人修改，请刷新");
      await db.execute(
        "UPDATE roles SET permissions=?,visible_fields=?,version=version+1 WHERE role_key=?",
        [JSON.stringify(permissions), JSON.stringify(fields), key],
      );
      await audit(db, r, "调整角色权限与字段可见性", key, {
        before: {
          permissions: json(row.permissions),
          visibleFields: json(row.visible_fields),
        },
        after: { permissions, visibleFields: fields },
        reason,
      });
      const count = await one(
        db,
        "SELECT COUNT(*) n FROM staff WHERE status='active' AND role_key=?",
        [key],
      );
      return roleView(
        await one(db, "SELECT * FROM roles WHERE role_key=?", [key]),
        count.n,
      );
    });
  });

  // ---------- 操作日志 ----------
  /** 审计内容按查看人的字段权限脱敏：看不到成本/毛利/供应商/内部备注/完整串码的人，日志里也看不到 */
  function redact(value, user) {
    const hidden = [
      [/cost|profit|margin/i, "cost"],
      [/supplier/i, "supplier"],
      [/internalNote/i, "internalNote"],
      [/imei/i, "fullImei"],
      [/wholesale/i, "wholesalePrice"],
      [/agent_?base/i, "agentBase"],
    ].filter(([, field]) => !canSee(user, field));
    const walk = (v) =>
      Array.isArray(v)
        ? v.map(walk)
        : v && typeof v === "object"
          ? Object.fromEntries(
              Object.entries(v).map(([k, x]) =>
                hidden.some(([re]) => re.test(k))
                  ? [k, "无权限查看"]
                  : [k, walk(x)],
              ),
            )
          : v;
    return walk(value);
  }
  route("GET", "/audit-logs", async (r) => {
    requirePerm(r, PERM.AUDIT_VIEW);
    if (!r.user.staffNo) fail(403, "仅员工可查看");
    const q = r.query,
      p = page(q),
      args = [],
      where = [];
    if (q.actorId) {
      where.push("a.actor_id=?");
      args.push(text(q.actorId, "操作人", 36));
    }
    if (q.action) {
      where.push("a.action=?");
      args.push(text(q.action, "动作", 80));
    }
    if (q.objectId) {
      where.push("a.object_id=?");
      args.push(text(q.objectId, "对象编号", 120));
    }
    for (const [k, op] of [
      ["from", ">="],
      ["to", "<"],
    ])
      if (q[k]) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(q[k])) fail(400, "日期格式无效");
        where.push(
          `a.created_at${op}DATE_SUB(?,INTERVAL 8 HOUR)` +
            (k === "to" ? "+INTERVAL 1 DAY" : ""),
        );
        args.push(q[k]);
      }
    const clause = where.length ? " WHERE " + where.join(" AND ") : "",
      count = await one(
        pool,
        "SELECT COUNT(*) n FROM audit_logs a" + clause,
        args,
      ),
      [rows] = await pool.query(
        "SELECT a.*,COALESCE(s.name,u.nickname) actor_name,s.role_key actor_role FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id LEFT JOIN staff s ON s.user_id=a.actor_id" +
          clause +
          " ORDER BY a.id DESC LIMIT ? OFFSET ?",
        [...args, p.pageSize, p.offset],
      );
    return list(
      rows.map((a) => ({
        id: String(a.id),
        action: a.action,
        objectId: a.object_id,
        actorId: a.actor_id,
        actorName: a.actor_name || "系统",
        actorRole: a.actor_role ? ROLE_LABELS[a.actor_role] : null,
        before: redact(json(a.before_data), r.user),
        after: redact(json(a.after_data), r.user),
        reason: a.reason,
        ip: a.ip,
        requestId: a.request_id,
        createdAt: a.created_at,
      })),
      count.n,
      p,
    );
  });
  route("GET", "/audit-logs/filters", async (r) => {
    requirePerm(r, PERM.AUDIT_VIEW);
    const [actions] = await pool.execute(
        "SELECT action,COUNT(*) n FROM audit_logs WHERE created_at>=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 180 DAY) GROUP BY action ORDER BY n DESC LIMIT 100",
      ),
      [actors] = await pool.execute(
        "SELECT s.user_id id,s.name FROM staff s WHERE s.user_id IS NOT NULL ORDER BY s.name",
      );
    return { actions: actions.map((a) => a.action), actors };
  });
};
