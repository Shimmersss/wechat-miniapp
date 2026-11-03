const { one } = require("./db");
const { PERM, fail, json, loadUser, SENSITIVE_FIELDS } = require("./core");
const { unitSelect, canSee } = require("./stock");
function shareService({ config }) {
  function canPeer(user) {
    return (
      !!user &&
      (user.role === "peer" ||
        (!!user.staffNo &&
          user.permissions.includes(PERM.SHARE) &&
          canSee(user, "wholesalePrice")))
    );
  }
  const isAgent = (user) =>
    !!user &&
    !user.staffNo &&
    user.role === "agent" &&
    user.agentStatus === "active";
  /** 渠道对应的分享开关：同行 sharePeer，代理 shareAgent，顾客 showInShop */
  const flagOf = (channel) =>
    channel === "peer"
      ? "sharePeer"
      : channel === "agent"
        ? "shareAgent"
        : "showInShop";
  function canCreate(user, channel) {
    if (!user) fail(401, "请登录后分享");
    if (channel === "agent" && !isAgent(user))
      fail(403, "仅已审核通过的代理可生成代理分享");
    if (channel === "peer" && !canPeer(user)) fail(403, "无同行分享权限");
    if (user.staffNo && !user.permissions.includes(PERM.SHARE))
      fail(403, "无分享权限");
  }
  async function resolve(db, shareId, user, { ownerOnly = false } = {}) {
    if (!/^[A-Za-z0-9_-]{16}$/.test(shareId || "")) fail(404, "分享不存在");
    const link = await one(db, "SELECT * FROM share_links WHERE id=?", [
      shareId,
    ]);
    if (!link || !link.active) fail(404, "分享不存在或已撤销");
    if (new Date(link.expires_at).getTime() <= Date.now())
      fail(410, "分享已过期");
    const owner = await loadUser(
      db,
      link.owner_id,
      link.owner_kind === "staff",
    );
    if (!owner) fail(410, "分享人账号已停用");
    if (
      link.owner_kind === "staff" &&
      (!owner.staffNo || !owner.permissions.includes(PERM.SHARE))
    )
      fail(410, "分享授权已变更");
    if (link.channel === "peer" && !canPeer(owner))
      fail(410, "同行分享授权已变更");
    if (link.channel === "agent" && !isAgent(owner))
      fail(410, "代理资格已变更，分享失效");
    if (ownerOnly && user?.id !== link.owner_id) fail(403, "无权管理该分享");
    if (link.channel === "peer" && !canPeer(user))
      fail(403, "此分享仅供已授权同行查看");
    const [items] = await db.execute(
      unitSelect +
        " JOIN share_items si ON si.unit_id=u.id WHERE si.share_id=? ORDER BY u.id",
      [link.id],
    );
    const [snapshots] = await db.execute(
      "SELECT * FROM share_items WHERE share_id=?",
      [link.id],
    );
    if (!items.length) fail(404, "分享暂无商品");
    for (const u of items) {
      const flags = json(u.share_flags),
        snapshot = snapshots.find((i) => i.unit_id === u.id);
      if (u.status !== "in_stock" || !flags[flagOf(link.channel)])
        fail(410, "分享中的设备已下架或不可售");
      if (u.price_version !== snapshot.price_version)
        fail(410, "商品价格已变化，请重新分享");
      u.sharePrice = Number(snapshot.price);
    }
    return { link, items };
  }
  async function publicView(db, u, { channel = "customer", price } = {}) {
    const a = json(u.attributes),
      snapshot = json(u.template_snapshot),
      audience = channel === "peer" ? "peer" : "customer";
    const [files] = await db.execute(
      "SELECT f.*,uf.field_key FROM unit_files uf JOIN files f ON f.id=uf.file_id WHERE uf.unit_id=? AND f.scope='public' ORDER BY uf.field_key,uf.position",
      [u.id],
    );
    const url = (f) =>
      config.publicOrigin + "/api/v1/files/" + f.id + "/content";
    const photos = files
        .filter(
          (f) => f.field_key === "publicImages" && f.mime.startsWith("image/"),
        )
        .map(url),
      videos = files
        .filter(
          (f) => f.field_key === "publicImages" && f.mime.startsWith("video/"),
        )
        .map(url);
    const forbidden = new Set([
      ...Object.keys(SENSITIVE_FIELDS),
      "imei1",
      "imei2",
      "receipt",
      "supplier",
      "internalNote",
      "cost",
      "retail",
      "wholesale",
      "agentBase",
    ]);
    const fields = snapshot.fields || [];
    const visible = (key) =>
      fields.some(
        (f) =>
          f.key === key &&
          f.visibility.includes(audience) &&
          !f.visibility.includes("internal"),
      );
    const value = (key) => (visible(key) ? a[key] : undefined);
    const publicFields = fields
      .filter(
        (f) =>
          !forbidden.has(f.key) &&
          f.visibility.includes(audience) &&
          !f.visibility.includes("internal"),
      )
      .map((f) => ({
        key: f.key,
        label: f.label,
        type: f.type,
        value:
          f.type === "image"
            ? files
                .filter((file) => file.field_key === f.key)
                .map((f) => ({ fileId: f.id, url: url(f) }))
            : a[f.key],
      }))
      .filter((f) => f.value !== undefined && f.value !== "");
    return {
      id: u.id,
      modelId: u.model_id,
      name: u.name,
      brand: u.brand,
      category: u.category_id,
      condition: u.condition_type,
      storage: value("storage") || "",
      color: value("color") || "",
      grade: value("grade") || "",
      battery: value("battery"),
      version: value("version"),
      images: photos,
      videos,
      cover: photos[0] || "",
      desc: channel === "peer" ? u.peer_desc : u.customer_desc,
      price:
        price === undefined
          ? Number(channel === "peer" ? u.wholesale : u.retail)
          : price,
      priceType:
        channel === "peer"
          ? "wholesale"
          : channel === "agent"
            ? "agent"
            : "retail",
      imeiMasked: u.imei1.slice(0, 2) + "****" + u.imei1.slice(-4),
      warrantyDays:
        value("shopWarranty") !== undefined && value("shopWarranty") !== ""
          ? Number(value("shopWarranty"))
          : null,
      publicFields,
    };
  }
  function snapshotPrice(ctx, u) {
    if (!ctx) return undefined;
    const snapshot = ctx.items.find((i) => i.id === u.id);
    if (!snapshot) fail(404, "商品不在本分享内");
    if (snapshot.price_version !== u.price_version)
      fail(410, "商品价格已变化，请重新分享");
    return snapshot.sharePrice;
  }
  async function context(db, r) {
    const value = r.headers["x-channel"];
    if (value) return resolve(db, value, r.user);
    return null;
  }
  async function unit(db, target, r, ctx) {
    const u = await one(db, unitSelect + " WHERE u.id=?", [target]);
    if (!u) fail(404, "商品不存在或已下架");
    const flags = json(u.share_flags),
      channel = ctx
        ? ctx.link.channel
        : r.user?.role === "peer"
          ? "peer"
          : "customer";
    if (ctx && !ctx.items.some((i) => i.id === u.id))
      fail(404, "商品不在本分享内");
    if (u.status !== "in_stock" || !flags[flagOf(channel)])
      fail(404, "商品不存在或已下架");
    return publicView(db, u, {
      channel,
      price: snapshotPrice(ctx, u),
    });
  }
  return {
    canPeer,
    isAgent,
    flagOf,
    canCreate,
    resolve,
    publicView,
    context,
    unit,
    snapshotPrice,
  };
}
module.exports = { shareService };
