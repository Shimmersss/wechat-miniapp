const { one } = require("./db");
const { PERM, SENSITIVE_FIELDS } = require("./core");
async function canReadInternal(db, file, user) {
  if (!user?.staffNo) return false;
  const loanLinked = !!(await one(
    db,
    "SELECT order_id FROM loan_files WHERE file_id=? LIMIT 1",
    [file.id],
  ));
  // Shared files require every linked domain's authorization, including races.
  if (loanLinked && !user.permissions.includes(PERM.LOAN_MANAGE)) return false;
  const [links] = await db.execute(
    "SELECT o.engineer_id,f.purpose FROM repair_files f JOIN repair_orders o ON o.id=f.order_id WHERE f.file_id=?",
    [file.id],
  );
  if (links.some((link) => link.purpose === "expense"))
    return (
      user.permissions.includes(PERM.REPAIR_CASH) &&
      SENSITIVE_FIELDS.cost.includes(user.role)
    );
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
  if (loanLinked) return true;
  return (
    file.owner_id === user.id ||
    ["boss", "manager", "purchaser"].includes(user.role)
  );
}
module.exports = { canReadInternal };
