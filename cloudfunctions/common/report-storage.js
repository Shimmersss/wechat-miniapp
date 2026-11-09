const { fail, hash } = require("./gateway");
const storage = require("./pg-storage");
const { render } = require("./report-csv");
const metadata = (r) => ({
  id: r.id,
  filename: "夏目数码_销售退款_" + r.id + ".csv",
  expiresAt: r.expiresAt,
  rows: Number(r.rows),
});
async function content(r, u) {
  const csv = render(r.payload, u),
    key = "reports/" + r.id + "/" + hash(csv) + ".csv",
    bucket = "xiamu-reports";
  if (!(await storage.info(bucket, key))) {
    const signed = await storage.json(
        "object/upload/sign/" + storage.objectPath(bucket, key),
        { headers: { "x-upsert": "true" } },
      ),
      url =
        signed.fullURL ||
        (signed.url ? new URL(signed.url, storage.origin()).href : null);
    if (!url) fail(503, "报表上传地址获取失败");
    const sent = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "text/csv;charset=utf-8" },
      body: Buffer.from(csv, "utf8"),
      signal: AbortSignal.timeout(
        Number(process.env.STORAGE_TIMEOUT_MS) || 12000,
      ),
    });
    if (!sent.ok) fail(503, "报表写入云存储失败，请重试");
  }
  const remaining = Math.floor((Date.parse(r.expiresAt) - Date.now()) / 1000);
  if (remaining <= 0) fail(410, "下载已过期，请重新导出");
  const signed = await storage.json(
      "object/sign/" + storage.objectPath(bucket, key),
      { body: { expiresIn: Math.min(300, remaining) } },
    ),
    url =
      signed.fullSignedURL ||
      (signed.signedURL
        ? new URL(signed.signedURL, storage.origin()).href
        : null);
  if (!url) fail(503, "报表下载链接获取失败");
  return { ...metadata(r), url };
}
module.exports = { metadata, content };
