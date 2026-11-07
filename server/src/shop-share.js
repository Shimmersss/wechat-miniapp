const crypto = require("node:crypto");
const { transaction, one } = require("./db");
const { PERM, fail, text, json, page, list, audit } = require("./core");
const { unitSelect } = require("./stock");
const { shareService } = require("./share-service");
module.exports = async function (app, { pool, config, route, providers }) {
  const { cents, money } = require("./validation");
  const service = shareService({ config });
  function metadata(link, units) {
    const one = units.length === 1,
      first = units[0];
    return {
      shareId: link.id,
      channel: link.channel,
      path:
        (one
          ? "/packages/shop/product/index"
          : "/packages/shop/collection/index") +
        "?s=" +
        link.id,
      title: one
        ? first.name + " " + first.storage + " ¥" + first.price
        : "夏目数码 · " + units.length + "台精选设备",
      price: one ? first.price : undefined,
      imageUrl: first.cover,
      expireAt: link.expires_at,
      units,
    };
  }
  async function resolved(r) {
    return service.resolve(pool, r.params.id, r.user);
  }
  route(
    "POST",
    "/share/links",
    async (r) => {
      const d = r.body || {},
        channel = d.channel || "customer";
      if (!["customer", "peer", "agent"].includes(channel))
        fail(400, "分享渠道无效");
      service.canCreate(r.user, channel);
      const ids = d.unitIds || [d.unitId];
      if (
        !Array.isArray(ids) ||
        !ids.length ||
        ids.length > 50 ||
        ids.some((i) => typeof i !== "string" || !i) ||
        new Set(ids).size !== ids.length
      )
        fail(400, "请选择1～50台不重复设备");
      // 分享有效期是运营配置（SHARE_HOURS），与代理收益无关；代理加价按框架文档 十三.1（固定金额上限、老板后台配置）在代理阶段实现。
      const hours = Number(config.share?.hours ?? 72);
      if (!Number.isFinite(hours) || hours < 1 || hours > 720)
        fail(503, "分享有效期配置无效");
      return transaction(pool, async (db) => {
        const shareId = crypto.randomBytes(12).toString("base64url"),
          expires = new Date(Date.now() + hours * 3600000),
          units = [];
        for (const unitId of ids.slice().sort()) {
          const u = await one(db, unitSelect + " WHERE u.id=? FOR SHARE", [
            text(unitId, "设备编号", 36),
          ]);
          if (
            !u ||
            u.status !== "in_stock" ||
            !json(u.share_flags)[service.flagOf(channel)]
          )
            fail(409, "所选设备不可对外分享");
          units.push(u);
        }
        const kind = r.user.staffNo
          ? "staff"
          : ["peer", "agent"].includes(r.user.role)
            ? r.user.role
            : "customer";
        // 代理分享价 = 代理底价 + 代理本人对该台的加价（框架文档 3.2、十三.1），一并快照
        for (const u of units) {
          if (channel !== "agent") continue;
          const m = await one(
            db,
            "SELECT markup FROM agent_markups WHERE agent_id=? AND unit_id=?",
            [r.user.id, u.id],
          );
          u.markupCents = m ? cents(m.markup) : 0;
          u.agentPrice = money(cents(u.agent_base) + u.markupCents);
        }
        await db.execute(
          "INSERT INTO share_links(id,owner_id,owner_kind,channel,expires_at) VALUES (?,?,?,?,?)",
          [shareId, r.user.id, kind, channel, expires],
        );
        for (const u of units)
          await db.execute(
            "INSERT INTO share_items(share_id,unit_id,price_version,price,markup) VALUES (?,?,?,?,?)",
            [
              shareId,
              u.id,
              u.price_version,
              channel === "peer"
                ? u.wholesale
                : channel === "agent"
                  ? u.agentPrice
                  : u.retail,
              channel === "agent" ? money(u.markupCents) : null,
            ],
          );
        await audit(db, r, "生成商品分享", shareId, {
          after: { channel, unitIds: ids, expiresAt: expires },
        });
        const views = await Promise.all(
          units.map((u) =>
            service.publicView(db, u, {
              channel,
              ...(channel === "agent" ? { price: Number(u.agentPrice) } : {}),
            }),
          ),
        );
        return metadata({ id: shareId, channel, expires_at: expires }, views);
      });
    },
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
  );
  route("GET", "/shop/shares/:id", async (r) => {
    const { link, items } = await resolved(r);
    return metadata(
      link,
      await Promise.all(
        items.map((u) =>
          service.publicView(pool, u, {
            channel: link.channel,
            price: u.sharePrice,
          }),
        ),
      ),
    );
  });
  route("PATCH", "/share/links/:id/revoke", async (r) => {
    if (!r.user) fail(401, "请先登录");
    const reason = text(r.body?.reason, "撤销说明", 500);
    return transaction(pool, async (db) => {
      const link = await one(
        db,
        "SELECT * FROM share_links WHERE id=? FOR UPDATE",
        [r.params.id],
      );
      if (!link || link.owner_id !== r.user.id) fail(404, "分享不存在");
      await db.execute("UPDATE share_links SET active=FALSE WHERE id=?", [
        link.id,
      ]);
      await audit(db, r, "撤销商品分享", link.id, { reason });
      return { revoked: true };
    });
  });
  route("GET", "/share/links/:id/copywriting", async (r) => {
    const { link, items } = await resolved(r),
      views = await Promise.all(
        items.map((u) =>
          service.publicView(pool, u, {
            channel: link.channel,
            price: u.sharePrice,
          }),
        ),
      );
    return {
      text:
        views
          .map(
            (u) =>
              u.name +
              " " +
              u.storage +
              " " +
              u.color +
              " ¥" +
              u.price +
              "\n" +
              u.desc,
          )
          .join("\n\n") + "\n夏目数码 · 实拍一机一检",
      shareId: link.id,
    };
  });
  const codeCache = new Map(),
    codePending = new Map();
  route(
    "GET",
    "/share/links/:id/poster",
    async (r) => {
      const { link, items } = await resolved(r),
        data = metadata(
          link,
          await Promise.all(
            items.map((u) =>
              service.publicView(pool, u, {
                channel: link.channel,
                price: u.sharePrice,
              }),
            ),
          ),
        );
      if (!providers.miniCode?.configured())
        return {
          ...data,
          qrcode: null,
          qrcodeStatus: "unconfigured",
          message: "暂无法生成可扫码海报，请使用小程序卡片分享",
        };
      let qrcode = codeCache.get(link.id);
      if (!qrcode) {
        let pending = codePending.get(link.id);
        if (!pending) {
          pending = providers.miniCode.generate({
            shareId: link.id,
            page:
              items.length === 1
                ? "packages/shop/product/index"
                : "packages/shop/collection/index",
          });
          codePending.set(link.id, pending);
        }
        try {
          qrcode = await pending;
          if (codeCache.size >= 128)
            codeCache.delete(codeCache.keys().next().value);
          codeCache.set(link.id, qrcode);
        } finally {
          if (codePending.get(link.id) === pending) codePending.delete(link.id);
        }
      }
      return { ...data, qrcode, qrcodeStatus: "ready" };
    },
    { config: { rateLimit: { max: 15, timeWindow: "1 minute" } } },
  );
  route("GET", "/shop/home", async (r) => {
    const ctx = await service.context(pool, r),
      scope = ctx
        ? " AND u.id IN (" + ctx.items.map(() => "?").join(",") + ")"
        : "",
      params = ctx ? ctx.items.map((u) => u.id) : [],
      flag = service.flagOf(
        ctx ? ctx.link.channel : r.user?.role === "peer" ? "peer" : "customer",
      );
    const [rows] = await pool.execute(
      "SELECT DISTINCT m.brand,m.brand_label FROM units u JOIN models m ON m.id=u.model_id WHERE u.status='in_stock' AND JSON_EXTRACT(u.share_flags,'$." +
        flag +
        "')=TRUE" +
        scope,
      params,
    );
    const count = await one(
      pool,
      "SELECT COUNT(*) n FROM units u WHERE u.status='in_stock' AND JSON_EXTRACT(u.share_flags,'$." +
        flag +
        "')=TRUE" +
        scope,
      params,
    );
    return {
      todayStock: Number(count.n),
      brands: [
        { value: "all", label: "全部" },
        ...rows.map((b) => ({ value: b.brand, label: b.brand_label })),
      ],
      banners: [],
    };
  });
  /** 顾客端筛选：成色、电池健康下限、价格区间；无此类条件返回 null */
  function factFilters(q) {
    const amount = (v, label) => {
      if (!/^\d{1,9}(\.\d{1,2})?$/.test(String(v)))
        fail(400, label + "须为非负金额，最多两位小数");
      return Number(v);
    };
    const grade = q.grade ? text(q.grade, "成色", 20) : "",
      min =
        q.priceMin !== undefined && q.priceMin !== ""
          ? amount(q.priceMin, "最低价")
          : null,
      max =
        q.priceMax !== undefined && q.priceMax !== ""
          ? amount(q.priceMax, "最高价")
          : null;
    let battery = null;
    if (q.batteryMin !== undefined && q.batteryMin !== "") {
      if (!/^\d{1,3}$/.test(String(q.batteryMin)) || Number(q.batteryMin) > 100)
        fail(400, "电池健康须为0～100的整数");
      battery = Number(q.batteryMin);
    }
    if (min !== null && max !== null && min > max)
      fail(400, "最低价不能高于最高价");
    if (!grade && min === null && max === null && battery === null) return null;
    const test = (u) =>
      (!grade || u.grade === grade) &&
      (min === null || u.price >= min) &&
      (max === null || u.price <= max) &&
      (battery === null ||
        (Number.isFinite(u.battery) && u.battery >= battery));
    return Object.assign(test, { min, max, grade, battery });
  }
  route("GET", "/shop/units", async (r) => {
    const ctx = await service.context(pool, r),
      p = page(r.query),
      q = r.query,
      flag = service.flagOf(
        ctx ? ctx.link.channel : r.user?.role === "peer" ? "peer" : "customer",
      );
    const where = [
        "u.status='in_stock'",
        "JSON_EXTRACT(u.share_flags,'$." + flag + "')=TRUE",
      ],
      args = [];
    if (ctx) {
      where.push("u.id IN (" + ctx.items.map(() => "?").join(",") + ")");
      args.push(...ctx.items.map((u) => u.id));
    }
    if (q.brand && q.brand !== "all") {
      where.push("m.brand=?");
      args.push(text(q.brand, "品牌", 50));
    }
    if (q.category) {
      where.push("m.category_id=?");
      args.push(text(q.category, "分类", 60));
    }
    if (q.modelId) {
      where.push("u.model_id=?");
      args.push(text(q.modelId, "型号", 60));
    }
    if (q.condition) {
      if (!["used", "new"].includes(q.condition)) fail(400, "设备类型无效");
      where.push("u.condition_type=?");
      args.push(q.condition);
    }
    if (q.keyword) {
      where.push(
        "(m.name LIKE ? OR JSON_UNQUOTE(JSON_EXTRACT(u.attributes,'$.storage')) LIKE ? OR JSON_UNQUOTE(JSON_EXTRACT(u.attributes,'$.color')) LIKE ?)",
      );
      const k = "%" + text(q.keyword, "搜索", 100) + "%";
      args.push(k, k, k);
    }
    const channel = ctx
        ? ctx.link.channel
        : flag === "sharePeer"
          ? "peer"
          : "customer",
      facts = factFilters(q),
      clause = " WHERE " + where.join(" AND "),
      sort = q.sort || "",
      view = (u) =>
        service.publicView(pool, u, {
          channel,
          price: service.snapshotPrice(ctx, u),
        });
    if (sort && !["price_asc", "price_desc"].includes(sort))
      fail(400, "排序方式无效");
    const price = channel === "peer" ? "u.wholesale" : "u.retail",
      order = sort
        ? ` ORDER BY ${price} ${sort === "price_asc" ? "ASC" : "DESC"},u.id`
        : " ORDER BY u.created_at DESC,u.id";
    if ((facts || sort) && ctx) {
      // 分享链接最多50台，价格以快照为准，在应用内筛选、排序后分页
      const [rows] = await pool.query(unitSelect + clause + order, args);
      const priced = rows.map((u) => ({
        u,
        fact: service.publicFacts(u, {
          channel,
          price: service.snapshotPrice(ctx, u),
        }),
      }));
      if (sort)
        priced.sort((a, b) =>
          sort === "price_asc"
            ? a.fact.price - b.fact.price
            : b.fact.price - a.fact.price,
        );
      const matched = priced
        .filter((row) => !facts || facts(row.fact))
        .map((row) => row.u);
      return list(
        await Promise.all(
          matched.slice(p.offset, p.offset + p.pageSize).map(view),
        ),
        matched.length,
        p,
      );
    }
    if (facts) {
      // 非分享渠道：价格/成色/电池全部在数据库筛选、计数与分页，不把候选全量取回应用。
      // 成色与电池只按该渠道模板公开（非内部）的字段取值，口径与 publicFacts 一致，未公开的设备不会被筛中。
      const audience = channel === "peer" ? "peer" : "customer",
        visible =
          // 不能写成 EXISTS + JSON_TABLE：优化器把它改写成半连接后先取 JSON_TABLE，
          // 此时还没读到 u，表函数为空，筛选永远查不到（MySQL 8.4 实测）。
          "JSON_CONTAINS(u.template_snapshot,JSON_OBJECT('key',?,'visibility',JSON_ARRAY(?)),'$.fields') AND NOT JSON_CONTAINS(u.template_snapshot,JSON_OBJECT('key',?,'visibility',JSON_ARRAY('internal')),'$.fields')";
      if (facts.min !== null) {
        where.push(price + ">=?");
        args.push(facts.min);
      }
      if (facts.max !== null) {
        where.push(price + "<=?");
        args.push(facts.max);
      }
      if (facts.grade) {
        where.push(
          visible + " AND JSON_UNQUOTE(JSON_EXTRACT(u.attributes,'$.grade'))=?",
        );
        args.push("grade", audience, "grade", facts.grade);
      }
      if (facts.battery !== null) {
        const value =
          "REPLACE(JSON_UNQUOTE(JSON_EXTRACT(u.attributes,'$.battery')),'%','')";
        where.push(
          visible +
            " AND " +
            value +
            " REGEXP '^[0-9]+([.][0-9]+)?$' AND CAST(" +
            value +
            " AS DECIMAL(20,6))>=?",
        );
        args.push("battery", audience, "battery", facts.battery);
      }
    }
    const filtered = " WHERE " + where.join(" AND ");
    const [rows] = await pool.query(
      unitSelect + filtered + order + " LIMIT ? OFFSET ?",
      [...args, p.pageSize, p.offset],
    );
    // 本页不满且非空（或首页为空）时总数已确定，省去一次计数扫描
    const total =
      rows.length < p.pageSize && (rows.length || !p.offset)
        ? p.offset + rows.length
        : (
            await one(
              pool,
              "SELECT COUNT(*) n FROM units u JOIN models m ON m.id=u.model_id" +
                filtered,
              args,
            )
          ).n;
    return list(await Promise.all(rows.map(view)), total, p);
  });
  route("GET", "/shop/units/:id", async (r) =>
    service.unit(pool, r.params.id, r, await service.context(pool, r)),
  );
  return service;
};
