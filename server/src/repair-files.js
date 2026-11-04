const { one } = require("./db");
const { PERM } = require("./core");
// stock 间接依赖本模块，调用时再取 canSee 以避免循环引用拿到空导出
const canSee = (...args) => require("./stock").canSee(...args);
async function canReadInternal(db, file, user) {
  if (!user?.staffNo) return false;
  const loanLinked = !!(await one(
    db,
    "SELECT order_id FROM loan_files WHERE file_id=? LIMIT 1",
    [file.id],
  ));
  // Shared files require every linked domain's authorization, including races.
  if (loanLinked && !user.permissions.includes(PERM.LOAN_MANAGE)) return false;
  // 销售收款凭证：须能查看销售单（开单/退款/经营统计）；不提前放行，其他关联业务的授权仍要满足
  const salesLinked = !!(await one(
    db,
    "SELECT order_id FROM sales_files WHERE file_id=? LIMIT 1",
    [file.id],
  ));
  if (
    salesLinked &&
    ![PERM.SALES_CREATE, PERM.REFUND, PERM.STATS_VIEW].some((p) =>
      user.permissions.includes(p),
    )
  )
    return false;
  const [links] = await db.execute(
    "SELECT o.engineer_id,f.purpose FROM repair_files f JOIN repair_orders o ON o.id=f.order_id WHERE f.file_id=?",
    [file.id],
  );
  if (links.some((link) => link.purpose === "expense"))
    return user.permissions.includes(PERM.REPAIR_CASH) && canSee(user, "cost");
  if (links.length)
    return links.some((link) =>
      link.purpose === "payment"
        ? user.permissions.includes(PERM.REPAIR_CASH)
        : (user.permissions.includes(PERM.REPAIR_HANDLE) &&
            (user.permissions.includes(PERM.REPAIR_ASSIGN) ||
              link.engineer_id === user.id)) ||
          (user.permissions.includes(PERM.REPAIR_CASH) &&
            link.purpose === "pickup"),
    );
  if (loanLinked || salesLinked) return true;
  return (
    file.owner_id === user.id ||
    ["boss", "manager", "purchaser"].includes(user.role)
  );
}
/**
 * 认领内部附件（入库/维修/借还/收款凭证）前调用：按文件编号顺序加排他锁，避免两个业务并发认领同一文件；
 * 之后用 fileLinks 的锁定读取（读最新已提交数据）核验关联，不能用普通快照读。
 */
async function lockFiles(db, ids) {
  const unique = [...new Set(ids.filter((x) => typeof x === "string"))].sort();
  if (!unique.length) return new Map();
  const [rows] = await db.query(
    "SELECT * FROM files WHERE id IN (?) ORDER BY id FOR UPDATE",
    [unique],
  );
  return new Map(rows.map((f) => [f.id, f]));
}
/** 文件已被哪些业务关联（锁定读取） */
async function fileLinks(db, fileId) {
  const has = async (table, column) =>
    !!(await one(
      db,
      "SELECT " +
        column +
        " FROM " +
        table +
        " WHERE file_id=? LIMIT 1 FOR SHARE",
      [fileId],
    ));
  return {
    unit: await has("unit_files", "unit_id"),
    repair: await has("repair_files", "order_id"),
    loan: await has("loan_files", "order_id"),
    sales: await has("sales_files", "order_id"),
  };
}
module.exports = { canReadInternal, lockFiles, fileLinks };
