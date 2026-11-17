const fail = (code, message) => {
  throw Object.assign(new Error(message), { code });
};
const money = (v) => {
  if (
    !["number", "string"].includes(typeof v) ||
    !/^\d{1,12}(\.\d{1,2})?$/.test(String(v).trim())
  )
    fail(400, "金额需为非负金额，最多两位小数");
  return String(v).trim();
};
const cents = (v) => {
  const [whole, fraction = ""] = money(v).split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
};
function suggest(d, discount = "0") {
  const cost = cents(d.cost),
    result = {};
  const add = (key, profitKey, value) => {
    const profit = cents(value),
      total = cost + profit;
    if (total > 99999999999999n) fail(400, "金额合计超出允许范围");
    result[key] = Number(total) / 100;
    result[profitKey] = Number(profit) / 100;
  };
  if (d.targetProfit !== undefined) {
    add("retail", "retailProfit", d.targetProfit);
    const peer = cents(result.retail) - cents(discount);
    result.wholesale = result.agentBase =
      Number(peer < cost ? cost : peer) / 100;
    result.wholesaleProfit = result.agentProfit =
      Number((peer < cost ? cost : peer) - cost) / 100;
    return result;
  }
  if (d.retailProfit !== undefined)
    add("retail", "retailProfit", d.retailProfit);
  if (d.wholesaleProfit !== undefined)
    add("wholesale", "wholesaleProfit", d.wholesaleProfit);
  // TODO(confirm): 代理利润留空暂随批发利润；WHOLESALE_DISCOUNT 仅保留兼容旧客户端。
  if (d.agentProfit !== undefined || d.wholesaleProfit !== undefined)
    add("agentBase", "agentProfit", d.agentProfit ?? d.wholesaleProfit);
  return result;
}
module.exports = { suggest };
