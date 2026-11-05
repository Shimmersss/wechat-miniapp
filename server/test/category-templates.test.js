const test = require("node:test"),
  assert = require("node:assert/strict");
const { fixture, imei, attributes } = require("./helpers");
const { one } = require("../src/db");
const { categoryTemplates } = require("../scripts/migrate");
let f, supplier, receipt;
const stamp = () => Date.now() + "_" + Math.random().toString(36).slice(2, 6);
test.before(async () => {
  f = await fixture(["boss", "warehouse", "sales"]);
  supplier = (
    await f.api("POST", "/suppliers", { name: "分类模板货源_" + stamp() })
  ).data;
  receipt = await f.upload();
});
test.after(async () => f?.close());
async function category(label) {
  const r = await f.api("POST", "/catalog/categories", {
    label,
    copyTemplateId: "t_phone",
  });
  assert.equal(r.status, 200, r.message);
  return r.data;
}
async function model(categoryId, name, specs) {
  const r = await f.api("POST", "/models", {
    category: categoryId,
    name,
    brandLabel: "验证品牌",
    series: "验证系列",
    tacs: [],
    ...(specs ? { specs } : {}),
  });
  assert.equal(r.status, 200, r.message);
  return r.data;
}

test("分类共用一套模板，型号只配置容量和颜色；入库按型号规格校验并写入快照", async () => {
  assert.equal(
    (await f.api("POST", "/catalog/categories", { label: "缺基础模板" }))
      .status,
    400,
  );
  const c = await category("模板分类_" + stamp());
  assert.ok(c.templateId);
  assert.ok(
    (await f.api("GET", "/catalog/categories")).data.list.some(
      (x) => x.value === c.value && x.templateId === c.templateId,
    ),
  );
  assert.equal(
    (
      await f.api("POST", "/models", {
        category: c.value,
        name: "重复颜色_" + stamp(),
        brandLabel: "验证品牌",
        series: "验证系列",
        specs: { color: ["银色", "银色"] },
      })
    ).status,
    400,
  );
  const a = await model(c.value, "型号A_" + stamp(), {
      storage: ["256G", "512G"],
      color: ["星宇橙色", "深蓝色"],
    }),
    b = await model(c.value, "型号B_" + stamp());
  assert.equal(a.templateId, c.templateId);
  assert.equal(b.templateId, c.templateId);
  assert.deepEqual(a.specs.color, ["星宇橙色", "深蓝色"]);
  // 入库表单：型号规格覆盖分类模板的容量和颜色，其余字段沿用分类模板
  const formA = (
      await f.api("GET", `/models/${a.id}/form`, undefined, "warehouse")
    ).data,
    formB = (await f.api("GET", `/models/${b.id}/form`)).data,
    base = (await f.api("GET", `/templates/${c.templateId}`)).data;
  assert.deepEqual(formA.fields.find((x) => x.key === "color").options, [
    "星宇橙色",
    "深蓝色",
  ]);
  assert.deepEqual(formA.fields.find((x) => x.key === "storage").options, [
    "256G",
    "512G",
  ]);
  assert.deepEqual(
    formB.fields.find((x) => x.key === "color").options,
    base.fields.find((x) => x.key === "color").options,
  );
  for (const key of [
    "idLock",
    "activation",
    "repairStatus",
    "networkLock",
    "warrantyUntil",
  ])
    assert.ok(
      formA.fields.some((x) => x.key === key),
      key,
    );
  assert.ok(
    !formA.fields.find((x) => x.key === "grade").options.includes("未激活"),
  );
  assert.equal(
    (await f.api("GET", `/models/${a.id}/form`, undefined, "sales")).status,
    403,
  );
  // 改分类模板一次，两个型号同时生效
  const published = await f.api("POST", `/templates/${c.templateId}/versions`, {
    baseVersion: base.version,
    fields: base.fields.concat({
      key: "boxNote",
      label: "包装说明",
      type: "text",
      required: false,
      filterable: false,
      visibility: ["customer", "peer"],
    }),
  });
  assert.equal(published.status, 200, published.message);
  const latestA = (await f.api("GET", `/models/${a.id}/form`)).data,
    latestB = (await f.api("GET", `/models/${b.id}/form`)).data;
  assert.equal(latestA.version, base.version + 1);
  assert.equal(latestB.version, base.version + 1);
  assert.ok(latestB.fields.some((x) => x.key === "boxNote"));
  const payload = {
    modelId: a.id,
    templateVersion: latestA.version,
    supplierId: supplier.id,
    inspectionConfirmed: true,
    attributes: attributes(latestA, receipt),
    cost: "100",
    retail: "200",
    wholesale: "180",
    agentBase: "180",
    flags: { showInShop: false, sharePeer: false, shareAgent: false },
  };
  // 型号规格之外的颜色不能入库
  let r = await f.api("POST", "/inbound/units", {
    ...payload,
    imei1: imei(),
    attributes: { ...payload.attributes, color: "黑色" },
  });
  assert.equal(r.status, 400);
  r = await f.api("POST", "/inbound/units", {
    ...payload,
    imei1: imei(),
    attributes: { ...payload.attributes, warrantyUntil: "2027-02-30" },
  });
  assert.equal(r.status, 400);
  r = await f.api("POST", "/inbound/units", { ...payload, imei1: imei() });
  assert.equal(r.status, 200, r.message);
  const snapshot = (
    await one(f.pool, "SELECT template_snapshot FROM units WHERE id=?", [
      r.data.id,
    ])
  ).template_snapshot;

  assert.equal(snapshot.id, c.templateId);
  assert.deepEqual(snapshot.fields.find((x) => x.key === "color").options, [
    "星宇橙色",
    "深蓝色",
  ]);
  // 修改型号不带 specs 时保留原规格；换分类后改用新分类模板
  const other = await category("模板分类二_" + stamp());
  r = await f.api("PUT", `/models/${a.id}`, {
    category: other.value,
    name: a.name,
    brandLabel: "验证品牌",
    series: "验证系列",
    tacs: [],
  });
  assert.equal(r.status, 200, r.message);
  assert.equal(r.data.templateId, other.templateId);
  assert.deepEqual(r.data.specs.color, ["星宇橙色", "深蓝色"]);
});

test("迁移：旧的每型号独立模板合并为分类模板，没有模板的分类复制手机模板", async () => {
  const legacy = "legacy_" + stamp(),
    empty = "empty_" + stamp(),
    templates = ["ta_" + stamp(), "tb_" + stamp()];
  await f.admin.execute(
    "INSERT INTO categories (id,label) VALUES (?,?),(?,?)",
    [legacy, "旧分类" + legacy.slice(-6), empty, "空分类" + empty.slice(-6)],
  );
  const phone = await one(
    f.admin,
    "SELECT v.fields FROM template_versions v JOIN templates t ON t.id=v.template_id AND v.version=t.current_version WHERE t.id='t_phone'",
  );
  for (const t of templates) {
    await f.admin.execute(
      "INSERT INTO templates (id,name,category_id,current_version) VALUES (?,?,?,1)",
      [t, t + "入库模板", legacy],
    );
    await f.admin.execute(
      "INSERT INTO template_versions (template_id,version,fields,description_presets) VALUES (?,1,?,?)",
      [
        t,
        JSON.stringify(phone.fields),
        JSON.stringify({ peer: [], customer: [] }),
      ],
    );
  }
  const models = [templates[0], templates[1], templates[1]].map((t, i) => ({
    id: "lm_" + i + "_" + stamp(),
    t,
  }));
  for (const m of models)
    await f.admin.execute(
      "INSERT INTO models (id,category_id,brand,brand_label,series,name,template_id) VALUES (?,?,?,?,?,?,?)",
      [m.id, legacy, "验证", "验证", "验证", m.id, m.t],
    );
  await categoryTemplates(f.admin);
  const legacyRow = await one(
    f.admin,
    "SELECT template_id FROM categories WHERE id=?",
    [legacy],
  );
  // 被型号使用最多的模板成为分类模板
  assert.equal(legacyRow.template_id, templates[1]);
  assert.equal(
    Number(
      (
        await one(
          f.admin,
          "SELECT COUNT(*) n FROM models WHERE category_id=? AND template_id<>?",
          [legacy, templates[1]],
        )
      ).n,
    ),
    0,
  );
  const emptyRow = await one(
    f.admin,
    "SELECT c.template_id,t.name FROM categories c JOIN templates t ON t.id=c.template_id WHERE c.id=?",
    [empty],
  );
  assert.match(emptyRow.name, /通用模板$/);
  // 旧模板与版本保留，已入库快照可追溯
  assert.ok(
    await one(f.admin, "SELECT id FROM templates WHERE id=?", [templates[0]]),
  );
  // 再跑一次不再变化
  await categoryTemplates(f.admin);
  assert.equal(
    (
      await one(f.admin, "SELECT template_id FROM categories WHERE id=?", [
        legacy,
      ])
    ).template_id,
    templates[1],
  );
});

test("模板管理页：新建分类复制基础模板，新建型号填容量颜色，编辑型号回显规格", async () => {
  const { client, page } = require("./page-helpers");
  const boss = client(f, "boss");
  const p = page("miniprogram/packages/staff/templates/index.js", boss);
  p.onLoad({ category: "phone" });
  await p.load();
  assert.ok(p.data.categoryTemplate, p.data.error);
  assert.equal(p.data.categoryTemplate.id, "t_phone");
  assert.ok(p.data.baseTemplates.some((t) => t.id === "t_phone"));
  p.onAddCategory();
  p.onCategoryInput({ detail: { value: "页面分类_" + stamp() } });
  await p.onSaveCategory();
  const created = p.data.filters.find((c) => c.value === p.data.activeFilter);
  assert.ok(created && created.templateId && created.templateId !== "t_phone");
  assert.equal(p.data.categoryTemplate.id, created.templateId);
  p.onAddModel();
  Object.assign(p.data.modelEditor, {
    brandLabel: "页面品牌",
    series: "页面系列",
    name: "页面型号_" + stamp(),
    storageText: "256G\n512G\n",
    colorText: "深蓝色\n 银色 ",
  });
  await p.onSaveModel();
  const saved = p.models()[0];
  assert.ok(saved, p.notices.join(","));
  assert.deepEqual(saved.specs, {
    storage: ["256G", "512G"],
    color: ["深蓝色", "银色"],
  });
  assert.equal(saved.templateId, created.templateId);
  assert.equal(saved.specText, "256G/512G · 2 种颜色");
  p.onSelectModel({ currentTarget: { dataset: { id: saved.id } } });
  assert.equal(p.data.modelEditor.colorText, "深蓝色\n银色");
  p.data.modelEditor.colorText = "";
  await p.onSaveModel();
  assert.deepEqual(p.models()[0].specs.color, []);
});
