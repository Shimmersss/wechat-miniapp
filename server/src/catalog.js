const { transaction, one } = require("./db");
const {
  PERM,
  fail,
  id,
  text,
  page,
  list,
  json,
  requirePerm,
  audit,
} = require("./core");
const { validateFields } = require("../../miniprogram/utils/template");
const { isImei } = require("../../miniprogram/utils/validate");
module.exports = async function catalog(app, { pool, route }) {
  const canManage = (request) =>
    request.user?.permissions.includes(PERM.TEMPLATE_MANAGE);
  const read = (request) =>
    requirePerm(
      request,
      PERM.TEMPLATE_MANAGE,
      PERM.INBOUND,
      PERM.PURCHASE_MANAGE,
      PERM.ACCEPTANCE,
    );
  const write = (request) => requirePerm(request, PERM.TEMPLATE_MANAGE);
  const readModels = (request) =>
    requirePerm(
      request,
      PERM.TEMPLATE_MANAGE,
      PERM.INBOUND,
      PERM.PURCHASE_MANAGE,
      PERM.ACCEPTANCE,
      PERM.INVENTORY_VIEW,
    );
  async function template(db, templateId, version) {
    const row = await one(
      db,
      `SELECT t.id,t.name,t.category_id category,v.version,v.fields,v.description_presets,u.nickname operator,v.published_at publishedAt
      FROM templates t JOIN template_versions v ON v.template_id=t.id AND v.version=${version ? "?" : "t.current_version"} LEFT JOIN users u ON u.id=v.operator_id WHERE t.id=?`,
      version ? [version, templateId] : [templateId],
    );
    if (!row) fail(404, "模板不存在");
    return {
      ...row,
      fields: json(row.fields),
      descriptionPresets: json(row.description_presets),
      description_presets: undefined,
    };
  }
  function presets(value) {
    if (
      !value ||
      typeof value !== "object" ||
      ["peer", "customer"].some(
        (k) =>
          !Array.isArray(value[k]) ||
          value[k].length > 6 ||
          value[k].some(
            (v) => typeof v !== "string" || !v.trim() || v.length > 200,
          ),
      )
    )
      fail(400, "每类快捷描述最多 6 句，每句 1～200 字");
    return {
      peer: value.peer.map((v) => v.trim()),
      customer: value.customer.map((v) => v.trim()),
    };
  }
  async function modelView(db, row, includeTac) {
    const result = {
      id: row.id,
      category: row.category_id,
      brand: row.brand,
      brandLabel: row.brand_label,
      series: row.series,
      name: row.name,
      templateId: row.template_id,
    };
    if (includeTac) {
      const [mappings] = await db.execute(
        "SELECT tac,source FROM tac_mappings WHERE model_id=? ORDER BY tac",
        [row.id],
      );
      result.tacs = mappings.map((r) => r.tac);
      result.tacSource = mappings[0]?.source || "";
    }
    return result;
  }
  route("GET", "/catalog/categories", async (request) => {
    readModels(request);
    const [rows] = await pool.execute(
      "SELECT id value,label FROM categories ORDER BY created_at,id",
    );
    return list(rows, rows.length, { page: 1, pageSize: rows.length });
  });
  route("POST", "/catalog/categories", async (request) => {
    write(request);
    const label = text(request.body?.label, "分类名称", 50),
      value = id();
    return transaction(pool, async (db) => {
      await db.execute("INSERT INTO categories (id,label) VALUES (?,?)", [
        value,
        label,
      ]);
      await audit(db, request, "新增分类", value, { after: { label } });
      return { value, label };
    });
  });
  route("PUT", "/catalog/categories/:id", async (request) => {
    write(request);
    const label = text(request.body?.label, "分类名称", 50);
    return transaction(pool, async (db) => {
      const current = await one(
        db,
        "SELECT * FROM categories WHERE id=? FOR UPDATE",
        [request.params.id],
      );
      if (!current) fail(404, "分类不存在");
      await db.execute("UPDATE categories SET label=? WHERE id=?", [
        label,
        current.id,
      ]);
      await audit(db, request, "修改分类", current.id, {
        before: { label: current.label },
        after: { label },
      });
      return { value: current.id, label };
    });
  });
  route("GET", "/models/tree", async (request) => {
    readModels(request);
    let sql = "SELECT * FROM models",
      params = [];
    if (request.query.category) {
      sql += " WHERE category_id=?";
      params.push(request.query.category);
    }
    sql += " ORDER BY brand_label,series,name";
    const [rows] = await pool.execute(sql, params);
    const brands = [];
    for (const row of rows) {
      let brand = brands.find((b) => b.id === row.brand);
      if (!brand) {
        brand = { id: row.brand, name: row.brand_label, series: [] };
        brands.push(brand);
      }
      let series = brand.series.find((s) => s.name === row.series);
      if (!series) {
        series = { name: row.series, models: [] };
        brand.series.push(series);
      }
      series.models.push(await modelView(pool, row, canManage(request)));
    }
    return brands;
  });
  async function saveModel(request, existingId) {
    write(request);
    const d = request.body || {};
    const name = text(d.name, "标准型号", 100),
      brandLabel = text(d.brandLabel, "品牌", 50),
      series = text(d.series, "系列", 50),
      category = text(d.category, "分类", 60);
    const tacs = d.tacs || [];
    if (
      !Array.isArray(tacs) ||
      tacs.length > 100 ||
      tacs.some((t) => typeof t !== "string" || !/^\d{8}$/.test(t)) ||
      new Set(tacs).size !== tacs.length
    )
      fail(400, "TAC 必须为不重复的八位数字");
    const source = tacs.length ? text(d.tacSource, "TAC 核验来源", 200) : "";
    return transaction(pool, async (db) => {
      if (!(await one(db, "SELECT id FROM categories WHERE id=?", [category])))
        fail(400, "分类不存在");
      const old = existingId
        ? await one(db, "SELECT * FROM models WHERE id=? FOR UPDATE", [
            existingId,
          ])
        : null;
      if (existingId && !old) fail(404, "型号不存在");
      const brandRow = await one(
        db,
        "SELECT brand FROM models WHERE brand_label=? LIMIT 1",
        [brandLabel],
      );
      const modelId = old?.id || id();
      let templateId = old?.template_id;
      const shared = old
        ? await one(db, "SELECT COUNT(*) n FROM models WHERE template_id=?", [
            templateId,
          ])
        : null;
      if (!old || (old.category_id !== category && Number(shared.n) > 1)) {
        const base = await template(
          db,
          old ? templateId : text(d.copyTemplateId, "基础模板", 60),
        );
        templateId = id();
        await db.execute(
          "INSERT INTO templates (id,name,category_id,current_version) VALUES (?,?,?,1)",
          [templateId, name + "入库模板", category],
        );
        await db.execute(
          "INSERT INTO template_versions (template_id,version,fields,description_presets,operator_id) VALUES (?,1,?,?,?)",
          [
            templateId,
            JSON.stringify(base.fields),
            JSON.stringify(base.descriptionPresets),
            request.user.id,
          ],
        );
      } else if (old.category_id !== category)
        await db.execute("UPDATE templates SET category_id=? WHERE id=?", [
          category,
          templateId,
        ]);
      if (old)
        await db.execute(
          "UPDATE models SET category_id=?,brand=?,brand_label=?,series=?,name=?,template_id=? WHERE id=?",
          [
            category,
            brandRow?.brand || brandLabel,
            brandLabel,
            series,
            name,
            templateId,
            modelId,
          ],
        );
      else
        await db.execute(
          "INSERT INTO models (id,category_id,brand,brand_label,series,name,template_id) VALUES (?,?,?,?,?,?,?)",
          [
            modelId,
            category,
            brandRow?.brand || brandLabel,
            brandLabel,
            series,
            name,
            templateId,
          ],
        );
      await db.execute("DELETE FROM tac_mappings WHERE model_id=?", [modelId]);
      for (const tac of tacs)
        await db.execute(
          "INSERT INTO tac_mappings (tac,model_id,source) VALUES (?,?,?)",
          [tac, modelId, source],
        );
      await audit(db, request, old ? "修改型号" : "新增型号", modelId, {
        before: old ? { name: old.name, category: old.category_id } : null,
        after: { name, category, templateId, tacs, source },
      });
      return modelView(
        db,
        await one(db, "SELECT * FROM models WHERE id=?", [modelId]),
        true,
      );
    });
  }
  route("POST", "/models", (request) => saveModel(request));
  route("PUT", "/models/:id", (request) =>
    saveModel(request, request.params.id),
  );
  route("GET", "/templates", async (request) => {
    write(request);
    const pagination = page(request.query),
      params = [],
      where = request.query.category ? " WHERE category_id=?" : "";
    if (where) params.push(request.query.category);
    const count = await one(
      pool,
      "SELECT COUNT(*) n FROM templates" + where,
      params,
    );
    const [rows] = await pool.query(
      "SELECT id FROM templates" + where + " ORDER BY name LIMIT ? OFFSET ?",
      [...params, pagination.pageSize, pagination.offset],
    );
    return list(
      await Promise.all(rows.map((r) => template(pool, r.id))),
      count.n,
      pagination,
    );
  });
  route("GET", "/templates/:id/versions", async (request) => {
    write(request);
    await template(pool, request.params.id);
    const pagination = page(request.query);
    const count = await one(
      pool,
      "SELECT COUNT(*) n FROM template_versions WHERE template_id=?",
      [request.params.id],
    );
    const [rows] = await pool.query(
      "SELECT version FROM template_versions WHERE template_id=? ORDER BY version DESC LIMIT ? OFFSET ?",
      [request.params.id, pagination.pageSize, pagination.offset],
    );
    return list(
      await Promise.all(
        rows.map((r) => template(pool, request.params.id, r.version)),
      ),
      count.n,
      pagination,
    );
  });
  route("GET", "/templates/:id", async (request) => {
    read(request);
    return template(pool, request.params.id);
  });
  route("POST", "/templates/:id/versions", async (request) => {
    write(request);
    const d = request.body || {},
      error = validateFields(d.fields);
    if (error) fail(400, error);
    return transaction(pool, async (db) => {
      const current = await one(
        db,
        "SELECT * FROM templates WHERE id=? FOR UPDATE",
        [request.params.id],
      );
      if (!current) fail(404, "模板不存在");
      if (d.baseVersion !== current.current_version)
        fail(409, "模板已更新，请刷新后编辑");
      const base = await template(db, current.id);
      const descriptions = presets(
        d.descriptionPresets === undefined
          ? base.descriptionPresets
          : d.descriptionPresets,
      );
      const version = current.current_version + 1;
      await db.execute(
        "INSERT INTO template_versions (template_id,version,fields,description_presets,operator_id) VALUES (?,?,?,?,?)",
        [
          current.id,
          version,
          JSON.stringify(d.fields),
          JSON.stringify(descriptions),
          request.user.id,
        ],
      );
      await db.execute("UPDATE templates SET current_version=? WHERE id=?", [
        version,
        current.id,
      ]);
      await audit(db, request, "发布模板版本", current.id, {
        before: { version: current.current_version },
        after: { version },
      });
      return template(db, current.id);
    });
  });
  route("POST", "/inbound/identify-model", async (request) => {
    requirePerm(request, PERM.INBOUND);
    const imei = text(request.body?.imei, "IMEI", 15);
    if (!isImei(imei)) fail(400, "IMEI 格式或校验位无效");
    const row = await one(
      pool,
      "SELECT m.*,t.source FROM tac_mappings t JOIN models m ON m.id=t.model_id WHERE t.tac=?",
      [imei.slice(0, 8)],
    );
    if (!row)
      return { matched: false, message: "未找到已核验型号，请手动选择" };
    return {
      matched: true,
      model: await modelView(pool, row, false),
      source: row.source,
      message: "请核对实机型号；容量、颜色与机况需另行填写",
    };
  });
  route("GET", "/shop/categories", async () => {
    const [categories] = await pool.execute(
      "SELECT id value,label FROM categories ORDER BY created_at,id",
    );
    const [models] = await pool.execute(
      "SELECT * FROM models ORDER BY brand_label,series,name",
    );
    return categories.map((category) => {
      const brands = [];
      for (const model of models.filter(
        (m) => m.category_id === category.value,
      )) {
        let brand = brands.find((b) => b.value === model.brand);
        if (!brand) {
          brand = { value: model.brand, label: model.brand_label, series: [] };
          brands.push(brand);
        }
        let series = brand.series.find((s) => s.label === model.series);
        if (!series) {
          series = { label: model.series, models: [] };
          brand.series.push(series);
        }
        series.models.push({ id: model.id, name: model.name });
      }
      return { ...category, brands };
    });
  });
};
