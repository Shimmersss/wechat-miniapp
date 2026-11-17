/** 同时核对函数私有配置与网关元数据，防止部署到默认环境。 */
function verifyTarget(envId, privateEnv, gateway) {
  if (privateEnv.CLOUDBASE_ENV_ID !== envId)
    throw new Error("目标云环境与私有配置的 CLOUDBASE_ENV_ID 不一致");
  if (gateway && (!gateway.envId || gateway.envId !== envId))
    throw new Error(
      "目标环境与 HTTPS 网关所属环境不一致，禁止部署到小程序默认环境",
    );
}
module.exports = { verifyTarget };
