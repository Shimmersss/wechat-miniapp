const config = require("../config/index");
const { isStaff, can } = require("./permission");
const { PERM } = require("../constants/roles");
function keyFor(user, batch) {
  if (!user?.id || !isStaff(user) || !can(user, PERM.INBOUND)) return "";
  const backend = config.useMock
    ? "mock"
    : config.useCloud
      ? config.cloudHttpBaseUrl || "gateway-unconfigured"
      : config.baseUrl;
  return [
    "xm_inbound_draft_v1",
    config.env,
    backend,
    user.id,
    user.staffNo || "",
    user.role,
    batch ? "batch" : "single",
  ]
    .map(encodeURIComponent)
    .join(":");
}

module.exports = { keyFor };
