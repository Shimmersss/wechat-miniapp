/** 非业务信封元信息：新实例首个调用、模块加载与处理耗时；不包含上下文或配置。 */
module.exports = function withStartupTiming(handler, moduleStarted) {
  const moduleLoadMs = Number(process.hrtime.bigint() - moduleStarted) / 1e6;
  let firstInvocation = true;
  return async (event, context) => {
    const coldStart = firstInvocation;
    firstInvocation = false;
    const started = process.hrtime.bigint();
    const result = await handler(event, context);
    return { ...result, timing: { coldStart, moduleLoadMs, handlerMs: Number(process.hrtime.bigint() - started) / 1e6 } };
  };
};
