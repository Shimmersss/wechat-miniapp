const { storageKeys } = require("../../../config/index");
const drafts = require("./draft");
const { PERM } = require("../../../constants/roles");
// 每台重新采集的字段；批量行的差异编辑也采用此清单。
const PER_UNIT_KEYS = [
  "battery",
  "grade",
  "ram",
  "imei1",
  "imei2",
  "serialNo",
  "noSerialReason",
];
const CLEAR_KEYS = ["battery", "imei1", "imei2", "serialNo", "noSerialReason"];
const COMMON_KEYS = ["shopWarranty", "warrantyLength", "store"];
function nextAttributes(fields, previous) {
  const values = { ...previous };
  fields.forEach((f) => {
    if (CLEAR_KEYS.includes(f.key) || f.type === "image")
      values[f.key] = f.type === "image" ? [] : "";
  });
  return values;
}
function keyFor(user, category) {
  const account = drafts.keyFor(user, false);
  return account && category
    ? `${storageKeys.inboundPreferences}:${account}:${encodeURIComponent(category)}`
    : "";
}
function supplierAllowed(user) {
  return (
    !!user?.permissions?.includes(PERM.SUPPLIER_VIEW) &&
    !!user?.visibleFields?.includes("supplier")
  );
}
function preferences(attributes, flags, supplierId, user) {
  return {
    attributes: Object.fromEntries(
      COMMON_KEYS.filter((k) => attributes[k] !== undefined).map((k) => [
        k,
        attributes[k],
      ]),
    ),
    flags: { ...flags },
    ...(supplierAllowed(user) && supplierId ? { supplierId } : {}),
  };
}
module.exports = {
  PER_UNIT_KEYS,
  nextAttributes,
  keyFor,
  preferences,
  supplierAllowed,
};
