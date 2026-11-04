/** Inventory domain: all mutation callers share these checks, DB uniqueness and ledger writes. */
const { one } = require("./db");
const { PERM, SENSITIVE_FIELDS, fail, id, text, json } = require("./core");
const { cents, money, flags } = require("./validation");
const { isImei } = require("../../miniprogram/utils/validate");
const { validateValues } = require("../../miniprogram/utils/template");
const { signFile } = require("./files");
/** 敏感字段可见性：按登录时加载的角色配置（roles.visible_fields）判断，未配置时用默认表 */
function canSee(user, field) {
  if (!user) return false;
  if (field === "agentBase")
    return ["boss", "manager", "purchaser"].includes(user.role);
  if (!SENSITIVE_FIELDS[field]) return true;
  return Array.isArray(user.visibleFields)
    ? user.visibleFields.includes(field)
    : SENSITIVE_FIELDS[field].includes(user.role);
}
const unitSelect = `SELECT u.*,m.name,m.brand,m.brand_label,m.category_id,m.series,s.name supplier_name FROM units u JOIN models m ON m.id=u.model_id LEFT JOIN suppliers s ON s.id=u.supplier_id`;
function stockService({ config }) {
  function fileView(file, request) {
    return {
      fileId: file.id,
      scope: file.scope,
      mime: file.mime,
      mediaType: file.mime.startsWith("video/") ? "video" : "image",
      url:
        file.scope === "public"
          ? `${config.publicOrigin}/api/v1/files/${file.id}/content`
          : signFile(config, file.id, request.sessionHash),
    };
  }
  async function normaliseFiles(
    db,
    input,
    scope,
    request,
    { imagesOnly = false, cache = new Map(), trustedIds = new Set() } = {},
  ) {
    if (input === undefined) return [];
    if (!Array.isArray(input) || input.length > 9)
      fail(400, "每个相册最多九个文件");
    const result = [];
    for (const value of input) {
      const fileId = text(value?.fileId, "文件标识", 36);
      if (result.some((f) => f.fileId === fileId))
        fail(400, "相册中存在重复文件");
      let file = cache.get(fileId);
      if (!file) {
        file = await one(db, "SELECT * FROM files WHERE id=?", [fileId]);
        if (file) cache.set(fileId, file);
      }
      if (!file || file.scope !== scope) fail(400, "文件不存在或上传范围不符");
      if (
        scope === "internal" &&
        (await one(
          db,
          "SELECT order_id FROM repair_files WHERE file_id=? LIMIT 1",
          [fileId],
        ))
      )
        fail(400, "维修附件不能用作入库凭证");
      if (
        scope === "internal" &&
        (await one(
          db,
          "SELECT order_id FROM loan_files WHERE file_id=? LIMIT 1",
          [fileId],
        ))
      )
        fail(400, "借还附件不能作为入库凭证");
      if (imagesOnly && !file.mime.startsWith("image/"))
        fail(400, "该模板字段只接受图片");
      if (
        scope === "internal" &&
        !trustedIds.has(fileId) &&
        file.owner_id !== request.user.id &&
        !["boss", "manager", "purchaser"].includes(request.user.role)
      )
        fail(403, "无权引用该内部凭证");
      result.push({ fileId });
    }
    return result;
  }
  async function prepare(db, input, request, context = {}) {
    const modelId = text(input.modelId, "型号", 60);
    const model = await one(
      db,
      `SELECT m.*,t.name template_name,t.current_version,v.fields,v.description_presets FROM models m JOIN templates t ON t.id=m.template_id JOIN template_versions v ON v.template_id=t.id AND v.version=t.current_version WHERE m.id=? FOR SHARE`,
      [modelId],
    );
    if (!model) fail(400, "型号不存在");
    if (input.templateVersion !== model.current_version)
      fail(409, "模板已更新，请重新加载型号");
    const fields = json(model.fields),
      attributes = {};
    if (
      !input.attributes ||
      typeof input.attributes !== "object" ||
      Array.isArray(input.attributes)
    )
      fail(400, "请填写模板参数");
    for (const f of fields)
      if (input.attributes[f.key] !== undefined)
        attributes[f.key] = input.attributes[f.key];
    const supplierId = context.supplierId || input.supplierId;
    let supplier = null;
    if (supplierId)
      supplier = await one(db, "SELECT * FROM suppliers WHERE id=?", [
        supplierId,
      ]);
    else if (attributes.supplier && canSee(request.user, "supplier"))
      supplier = await one(
        db,
        "SELECT * FROM suppliers WHERE name=? AND active=TRUE",
        [attributes.supplier],
      );
    if (supplierId && !supplier) fail(400, "供应商不存在");
    if (supplier && !context.supplierId && !supplier.active)
      fail(400, "供应商已停用");
    if (supplier && fields.some((f) => f.key === "supplier"))
      attributes.supplier = supplier.name;
    if (fields.some((f) => f.key === "supplier" && f.required) && !supplier)
      fail(400, "请关联有效供应商；库管可从采购验收单入库");
    if (
      input.receiptImages &&
      fields.some((f) => f.key === "receipt" && f.type === "image") &&
      !attributes.receipt?.length
    )
      attributes.receipt = input.receiptImages;
    const files = context.files || new Map();
    for (const f of fields.filter((f) => f.type === "image"))
      attributes[f.key] = await normaliseFiles(
        db,
        attributes[f.key],
        f.visibility.includes("internal") ? "internal" : "public",
        request,
        {
          imagesOnly: true,
          cache: files,
          trustedIds: context.trustedReceiptIds,
        },
      );
    const error = validateValues(fields, attributes);
    if (error) fail(400, error);
    const imei1 = text(input.imei1, "IMEI1", 15),
      imei2 = text(input.imei2, "IMEI2", 15, true);
    const seen = context.seen || new Set();
    for (const imei of [imei1, imei2].filter(Boolean)) {
      if (!isImei(imei)) fail(400, "IMEI 格式或校验位无效");
      if (seen.has(imei)) fail(400, "本次提交存在重复串码");
      seen.add(imei);
      if (
        await one(
          db,
          "SELECT order_id FROM repair_external_slots WHERE identifier=? FOR SHARE",
          [imei],
        )
      )
        fail(409, "串码正在外部维修中，不能作为本店库存入库");
      const existing = await one(
        db,
        "SELECT * FROM unit_identifiers WHERE imei=?",
        [imei],
      );
      if (
        existing &&
        !(
          context.reservedItemId &&
          existing.acceptance_item_id === context.reservedItemId &&
          !existing.unit_id
        )
      )
        fail(409, "串码已入库或正在异常验收中");
    }
    const mapping = await one(
      db,
      "SELECT model_id FROM tac_mappings WHERE tac=?",
      [imei1.slice(0, 8)],
    );
    if (mapping && mapping.model_id !== modelId)
      fail(400, "串码识别型号与所选型号不一致");
    const condition = input.condition || "used";
    if (!["used", "new"].includes(condition)) fail(400, "设备类型无效");
    const cost =
      context.cost !== undefined
        ? context.cost
        : money(cents(input.cost, "成本价"));
    const retail = money(cents(input.retail, "零售价")),
      wholesale = money(cents(input.wholesale, "批发价")),
      agentBase = money(cents(input.agentBase, "代理底价"));
    const status =
      attributes.refurbishment === "正在整备" ? "recheck" : "in_stock";
    const shareFlags = flags(input.flags || {});
    if (status !== "in_stock")
      Object.keys(shareFlags).forEach((k) => {
        shareFlags[k] = false;
      });
    const receiptImages = await normaliseFiles(
      db,
      input.receiptImages,
      "internal",
      request,
      { imagesOnly: true, cache: files, trustedIds: context.trustedReceiptIds },
    );
    const publicImages = await normaliseFiles(
      db,
      input.publicImages,
      "public",
      request,
      { cache: files },
    );
    return {
      id: id(),
      modelId,
      imei1,
      imei2,
      condition,
      status,
      cost,
      retail,
      wholesale,
      agentBase,
      supplierId: supplier?.id || null,
      attributes,
      shareFlags,
      publicImages,
      receiptImages,
      peerDesc: text(input.peerDesc, "同行描述", 4000, true),
      customerDesc: text(input.customerDesc, "顾客描述", 4000, true),
      internalNote: text(input.internalNote, "内部备注", 4000, true),
      snapshot: {
        id: model.template_id,
        name: model.template_name,
        category: model.category_id,
        version: model.current_version,
        fields,
        descriptionPresets: json(model.description_presets),
      },
    };
  }
  async function ledger(
    db,
    request,
    unitId,
    from,
    to,
    docType,
    docId,
    reason = "",
  ) {
    await db.execute(
      "INSERT INTO inventory_ledger (unit_id,from_status,to_status,doc_type,doc_id,operator_id,reason) VALUES (?,?,?,?,?,?,?)",
      [unitId, from, to, docType, docId, request.user.id, reason],
    );
  }
  async function insert(db, prepared, request, context = {}) {
    const u = prepared;
    await db.execute(
      `INSERT INTO units (id,model_id,imei1,imei2,status,condition_type,attributes,template_snapshot,cost,retail,wholesale,agent_base,share_flags,peer_desc,customer_desc,internal_note,purchase_line_id,acceptance_item_id,inbound_operator_id,supplier_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        u.id,
        u.modelId,
        u.imei1,
        u.imei2 || null,
        u.status,
        u.condition,
        JSON.stringify(u.attributes),
        JSON.stringify(u.snapshot),
        u.cost,
        u.retail,
        u.wholesale,
        u.agentBase,
        JSON.stringify(u.shareFlags),
        u.peerDesc,
        u.customerDesc,
        u.internalNote,
        context.purchaseLineId || null,
        context.acceptanceItemId || null,
        request.user.id,
        u.supplierId,
      ],
    );
    for (const [slot, imei] of [
      ["imei1", u.imei1],
      ["imei2", u.imei2],
    ].filter((x) => x[1])) {
      if (context.reservedItemId) {
        const [updated] = await db.execute(
          "UPDATE unit_identifiers SET unit_id=? WHERE imei=? AND acceptance_item_id=? AND unit_id IS NULL",
          [u.id, imei, context.reservedItemId],
        );
        if (updated.affectedRows !== 1) fail(409, "异常验收串码已变更，请刷新");
      } else
        await db.execute(
          "INSERT INTO unit_identifiers (imei,unit_id,acceptance_item_id,slot) VALUES (?,?,?,?)",
          [imei, u.id, context.acceptanceItemId || null, slot],
        );
    }
    const fileFields = [
      ["publicImages", u.publicImages],
      ["receiptImages", u.receiptImages],
      ...u.snapshot.fields
        .filter((f) => f.type === "image")
        .map((f) => [f.key, u.attributes[f.key] || []]),
    ];
    for (const [key, files] of fileFields)
      for (let i = 0; i < files.length; i++)
        await db.execute(
          "INSERT INTO unit_files (unit_id,file_id,field_key,position) VALUES (?,?,?,?)",
          [u.id, files[i].fileId, key, i],
        );
    await db.execute(
      "INSERT INTO unit_inspections (id,unit_id,result,attributes,operator_id,reason) VALUES (?,?,?,?,?,?)",
      [
        id(),
        u.id,
        "pass",
        JSON.stringify(u.attributes),
        request.user.id,
        "首次验收确认",
      ],
    );
    await ledger(
      db,
      request,
      u.id,
      context.acceptanceItemId ? "accepting" : null,
      u.status,
      context.acceptanceItemId ? "acceptance" : "inbound",
      context.acceptanceItemId || u.id,
      context.reason || "已核验型号、串码、机况与凭证",
    );
    return u.id;
  }
  async function get(db, unitId, lock = false) {
    const row = await one(
      db,
      unitSelect + " WHERE u.id=?" + (lock ? " FOR UPDATE" : ""),
      [unitId],
    );
    if (!row) fail(404, "设备不存在");
    return row;
  }
  async function view(db, row, request) {
    const attributes = json(row.attributes),
      snapshot = json(row.template_snapshot),
      imeiMasked = `${row.imei1.slice(0, 2)}****${row.imei1.slice(-4)}`;
    const [attached] = await db.execute(
      "SELECT f.*,uf.field_key FROM unit_files uf JOIN files f ON f.id=uf.file_id WHERE uf.unit_id=? ORDER BY uf.field_key,uf.position",
      [row.id],
    );
    const visibleFile = (f) =>
      f.scope === "public" ||
      (request.user?.staffNo &&
        (f.owner_id === request.user.id ||
          ["boss", "manager", "purchaser"].includes(request.user.role)));
    const result = {
      id: row.id,
      modelId: row.model_id,
      name: row.name,
      brand: row.brand,
      category: row.category_id,
      status: row.status,
      ownership: row.ownership,
      condition: row.condition_type,
      imeiMasked,
      storage: attributes.storage,
      color: attributes.color,
      grade: attributes.grade,
      battery: attributes.battery,
      version: attributes.version,
      retail: Number(row.retail),
      flags: json(row.share_flags),
      peerDesc: row.peer_desc,
      customerDesc: row.customer_desc,
      createdAt: row.created_at,
      ageDays: Math.max(
        0,
        Math.floor(
          (Date.now() - new Date(row.created_at).getTime()) / 86400000,
        ),
      ),
      images: attached
        .filter(
          (f) => f.field_key === "publicImages" && f.mime.startsWith("image/"),
        )
        .map((f) => fileView(f, request).url),
      publicImages: attached
        .filter((f) => f.field_key === "publicImages")
        .map((f) => fileView(f, request)),
      priceVersion: row.price_version,
    };
    if (canSee(request.user, "fullImei")) {
      result.imei1 = row.imei1;
      result.imei2 = row.imei2;
    }
    if (canSee(request.user, "cost")) result.cost = Number(row.cost);
    if (canSee(request.user, "supplier")) {
      result.supplier = row.supplier_name || "";
      result.supplierId = row.supplier_id;
    }
    if (canSee(request.user, "internalNote"))
      result.internalNote = row.internal_note;
    if (canSee(request.user, "wholesalePrice"))
      result.wholesale = Number(row.wholesale);
    if (canSee(request.user, "agentBase"))
      result.agentBase = Number(row.agent_base);
    const receipt = [
      ...new Map(
        attached
          .filter((f) => f.scope === "internal" && visibleFile(f))
          .map((f) => [f.id, f]),
      ).values(),
    ];
    if (receipt.length)
      result.receiptImages = receipt.map((f) => fileView(f, request));
    result.parameters = snapshot.fields
      .filter(
        (f) =>
          canSee(request.user, f.key) &&
          (!f.visibility.includes("internal") ||
            canSee(request.user, "internalNote")) &&
          !(f.key === "receipt" && !receipt.length),
      )
      .map((f) => ({
        key: f.key,
        label: f.label,
        type: f.type,
        value:
          f.type === "image"
            ? attached
                .filter((file) => file.field_key === f.key && visibleFile(file))
                .map((file) => fileView(file, request))
            : attributes[f.key],
      }))
      .filter((f) => f.value !== undefined);
    result.availableActions =
      row.status === "recheck" &&
      request.user.permissions.includes(PERM.ACCEPTANCE)
        ? ["recheck"]
        : [];
    return result;
  }
  return { prepare, insert, ledger, get, view, normaliseFiles, fileView };
}
module.exports = { stockService, unitSelect, canSee };
