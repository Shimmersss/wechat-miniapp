// 定时调用只处理已到期的锁，不接受客户端指定记录或任意SQL。
const { rpc } = require("./shared/gateway");
exports.main = async () => ({
  code: 0,
  data: await rpc("agent_release_expired", {}),
  message: "ok",
});
