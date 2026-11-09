#!/usr/bin/env node
/** 真实过期对象清理验收：只制造明确可丢弃的小夹具，验证引用/租约/保护与30天保留边界。 */
const fs = require("node:fs"),
  crypto = require("node:crypto"),
  assert = require("node:assert/strict");
const {
  pg,
  rpc,
  source,
  variables,
  privateJSON,
  save,
  native,
  evaluate,
} = require("./lib/cloud-verification");
const { invoke } = require("./run-cloud-maintenance");
const env = privateJSON("sms-config-before").envId,
  base = `https://${env}.api.tcloudbasegateway.com/v1/storages/`,
  auth = { Authorization: "Bearer " + variables.CLOUDBASE_API_KEY },
  key = () => crypto.randomUUID(),
  sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const bytes = fs.readFileSync("miniprogram/assets/brands/apple.png"),
  old = new Date(Date.now() - 48 * 3600000).toISOString(),
  future = new Date(Date.now() + 1200000).toISOString();
async function storage(p, method = "GET", body) {
  const r = await fetch(base + p, {
    method,
    headers: {
      ...auth,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw Error("清理验收存储操作失败 HTTP " + r.status);
  return r;
}
async function put(
  bucket,
  name,
  data = bytes,
  mime = "application/octet-stream",
) {
  const r = await storage(
      "object/upload/sign/" + bucket + "/" + name,
      "POST",
      {},
    ),
    s = await r.json(),
    url = s.fullURL || new URL(s.url, base).href;
  const sent = await fetch(url, {
    method: "PUT",
    body: data,
    headers: { "Content-Type": mime },
  });
  assert.ok(sent.ok);
  return { bucket, key: name };
}
async function exists(o) {
  const r = await fetch(base + "object/info/" + o.bucket + "/" + o.key, {
    headers: auth,
    signal: AbortSignal.timeout(10000),
  });
  if (r.status === 404) return false;
  assert.ok(r.ok);
  return true;
}
const phase = process.argv[2] || "prepare";
(async () => {
  if (phase === "prepare") {
    const role = privateJSON("role-fixture"),
      who = role.people.boss,
      { call } = source();
    const keep = [],
      remove = [],
      ids = {};
    async function uploadState(
      label,
      status = "failed",
      expires = old,
      lease = false,
    ) {
      const id = key();
      ids[label] = id;
      await pg("file_uploads", "POST", {
        id,
        owner_id: who.id,
        scope: "internal",
        expected_size: bytes.length,
        request_key: "gc-" + key(),
        status,
        expires_at: expires,
        ...(lease ? { lease: key(), lease_until: future } : {}),
      });
      return id;
    }
    // 先只放一个候选，取得租约后新增保护，授权必须重新检查。
    const race = await uploadState("race"),
      raceObject = await put("xiamu-staging", race);
    keep.push(raceObject);
    const first = await rpc("api_maintenance_gc", {
        p_action: "take",
        p_data: {},
      }),
      racing = first.tasks.find((t) => t.key === race);
    assert.ok(racing);
    await pg("maintenance_protections", "POST", {
      kind: "upload",
      record_id: race,
      reason: "清理租约取得后新增保护，必须停止删除",
    });
    assert.equal(
      (
        await rpc("api_maintenance_gc", {
          p_action: "authorize",
          p_data: { id: racing.id, lease: racing.lease },
        })
      ).allowed,
      false,
    );
    await rpc("api_maintenance_gc", {
      p_action: "ack",
      p_data: { id: racing.id, lease: racing.lease, skipped: true },
    });
    const failed = await uploadState("failed"),
      sealed = failed + "-" + key();
    remove.push(
      await put("xiamu-staging", failed),
      await put("xiamu-sealed", sealed),
      await put("xiamu-internal", sealed, bytes, "image/png"),
    );
    const abandoned = await uploadState("abandoned", "pending");
    remove.push(await put("xiamu-staging", abandoned));
    const active = await uploadState("active", "pending", future);
    keep.push(await put("xiamu-staging", active));
    const leased = await uploadState("leased", "verifying", old, true);
    keep.push(await put("xiamu-staging", leased));
    const protectedId = await uploadState("protected");
    keep.push(await put("xiamu-staging", protectedId));
    await pg("maintenance_protections", "POST", {
      kind: "upload",
      record_id: protectedId,
      reason: "清理保护清单验收对象，保留验证证据",
    });
    // 真正走上传核验和收款凭证关联；只补造遗留的暂存/校验副本，正式文件必须保留。
    const intent = await call(who, "files", "/files/upload-intent", "POST", {
      scope: "internal",
      requestKey: key(),
      size: bytes.length,
    });
    assert.ok(
      (await fetch(intent.uploadUrl, { method: "PUT", body: bytes })).ok,
    );
    let ready;
    for (let n = 0; n < 8; n++) {
      ready = await call(
        who,
        "files",
        "/files/" + intent.uploadId + "/complete",
        "POST",
      );
      if (ready.fileId) break;
    }
    assert.ok(ready.fileId);
    await call(
      who,
      "staff-sales",
      "/sales-orders/" + role.saleId + "/receipts",
      "POST",
      {
        receipts: [{ fileId: ready.fileId }],
        reason: "验证已关联业务的正式凭证不会被清理",
      },
    );
    await pg("file_uploads?id=eq." + ready.fileId, "PATCH", {
      expires_at: old,
    });
    ids.ready = ready.fileId;
    const registered = (
      await pg("files?id=eq." + ready.fileId + "&select=stored_name")
    )[0];
    const split = registered.stored_name.indexOf("/");
    keep.push({
      bucket: registered.stored_name.slice(0, split),
      key: registered.stored_name.slice(split + 1),
    });
    remove.push(
      await put("xiamu-staging", ready.fileId),
      await put("xiamu-sealed", ready.fileId + "-" + key()),
    );
    const csv = Buffer.from("\ufeff清理测试\r\n", "utf8");
    for (const [label, expires, protect] of [
      ["reportOld", old, false],
      ["reportFresh", future, false],
      ["reportProtected", old, true],
    ]) {
      const id = key();
      ids[label] = id;
      await pg("report_exports", "POST", {
        id,
        actor_id: who.id,
        request_key: "gc-" + key(),
        request_hash: sha(Buffer.from(id)),
        payload: { rows: [], costAccess: false, profitAccess: false },
        expires_at: expires,
      });
      const obj = await put(
        "xiamu-reports",
        "reports/" + id + "/" + sha(csv) + ".csv",
        csv,
        "text/csv;charset=utf-8",
      );
      (label === "reportOld" ? remove : keep).push(obj);
      if (protect)
        await pg("maintenance_protections", "POST", {
          kind: "report",
          record_id: id,
          reason: "保留报表清理验证证据",
        });
    }
    let day;
    do {
      day =
        "1900-" +
        String(crypto.randomInt(1, 13)).padStart(2, "0") +
        "-" +
        String(crypto.randomInt(1, 29)).padStart(2, "0");
    } while (
      (await pg("maintenance_backup_jobs?day=eq." + day + "&select=id")).length
    );
    const obsolete = key(),
      data = Buffer.from(
        JSON.stringify({ type: "disposable-retention-probe" }),
      );
    ids.obsoleteBackup = obsolete;
    await pg("maintenance_backup_jobs", "POST", {
      id: obsolete,
      day,
      status: "complete",
      snapshot_at: new Date(Date.now() - 46 * 86400000).toISOString(),
      completed_at: new Date(Date.now() - 45 * 86400000).toISOString(),
      manifest: { type: "disposable-retention-probe" },
      manifest_sha: sha(data),
      marker_written: true,
    });
    remove.push(
      await put(
        "xiamu-backups",
        "daily/" + day + "/" + obsolete + "/manifest.json",
        data,
        "application/json",
      ),
      await put(
        "xiamu-backups",
        "daily/" + day + "/complete.json",
        data,
        "application/json",
      ),
    );
    const [a, b] = await Promise.all([
      rpc("api_maintenance_gc", { p_action: "take", p_data: {} }),
      rpc("api_maintenance_gc", { p_action: "take", p_data: {} }),
    ]);
    assert.equal(
      a.tasks.filter((x) => b.tasks.some((y) => y.id === x.id)).length,
      0,
    );
    assert.ok(a.tasks.length + b.tasks.length > 0);
    save("maintenance-gc-fixture", {
      keep,
      remove,
      ids,
      who,
      concurrency: {
        disjoint: true,
        first: a.tasks.length,
        second: b.tasks.length,
      },
      leaseReadyAt: Date.now() + 31000,
    });
    console.log(
      JSON.stringify({
        prepared: true,
        objectsToDelete: remove.length,
        objectsToKeep: keep.length,
        concurrentLeasesDisjoint: true,
      }),
    );
  } else if (phase === "verify") {
    const f = privateJSON("maintenance-gc-fixture");
    if (Date.now() < f.leaseReadyAt)
      await new Promise((r) => setTimeout(r, f.leaseReadyAt - Date.now()));
    let complete = false,
      deleted = 0;
    for (let i = 0; i < 12; i++) {
      const r = await invoke({ gc: true });
      deleted += r.data.deleted;
      complete = r.data.gcComplete;
      if (complete) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    assert.equal(complete, true, "真实维护函数应完成全部候选");
    for (const o of f.remove)
      assert.equal(await exists(o), false, "过期夹具应实际删除");
    for (const o of f.keep)
      assert.equal(
        await exists(o),
        true,
        "引用/活跃/租约/保护/未过期对象必须保留",
      );
    const { call } = source(),
      ready = await call(f.who, "files", "/files/" + f.ids.ready);
    assert.ok((await fetch(ready.url)).ok, "清理之后已关联业务凭证仍可下载");
    const backup = privateJSON("maintenance-completed-job"),
      root = "daily/" + backup.day + "/" + backup.id + "/manifest.json";
    assert.equal(await exists({ bucket: "xiamu-backups", key: root }), true);
    const sourceEvent = await pg(
      "maintenance_events?kind=eq.gc_deleted&select=id&limit=10000",
    );
    assert.ok(sourceEvent.length >= f.remove.length);
    const denied = evaluate(async function () {
      const r = await wx.cloud.callFunction({
        name: "cloud-maintenance",
        data: { Type: "Timer", TriggerName: "forged" },
      });
      return r.result.code;
    });
    assert.equal(denied, 403);
    const anonymous = await fetch(base + "object/xiamu-backups/" + root);
    assert.ok(!anonymous.ok);
    const result = {
      passed: true,
      deletedObjects: f.remove.length,
      preservedObjects: f.keep.length,
      concurrentLeases: f.concurrency,
      clientInvokeCode: denied,
      anonymousBackupStatus: anonymous.status,
      checks: [
        "真实删除失败/放弃上传暂存、校验及未登记正式副本；已登记且关联销售的凭证保留且仍可真实下载",
        "未到期上传、活跃租约、保护清单与租约后新增保护不删除",
        "过期报表对象删除，未过期和受保护报表保留；PG快照与审计不删除",
        "超过30天的独立保留期夹具被删除，最近完整备份及恢复证据保留；并发取得任务不重叠",
        "真实微信伪造Timer调用403，备份对象匿名直读拒绝",
      ],
    };
    save("maintenance-gc-results", result);
    console.log(JSON.stringify(result));
  } else throw Error("支持 prepare/verify");
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
