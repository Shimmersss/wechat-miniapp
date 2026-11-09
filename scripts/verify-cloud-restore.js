#!/usr/bin/env node
/** 从私有云备份实际下载、校验并恢复到隔离PG表/媒体目录；绝不覆盖生产表或原媒体。 */
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto"),
  zlib = require("node:zlib"),
  assert = require("node:assert/strict");
const {
  pg,
  rpc,
  variables,
  privateJSON,
  save,
  local,
  source,
} = require("./lib/cloud-verification");
const { invoke } = require("./run-cloud-maintenance");
const hash = (b) => crypto.createHash("sha256").update(b).digest("hex"),
  env = privateJSON("sms-config-before").envId,
  base = `https://${env}.api.tcloudbasegateway.com/v1/storages/`,
  auth = { Authorization: "Bearer " + variables.CLOUDBASE_API_KEY };
async function request(resource, options = {}) {
  const r = await fetch(base + resource, {
    ...options,
    headers: { ...auth, ...options.headers },
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw Error("恢复演练存储请求失败 HTTP " + r.status);
  return r;
}
async function object(key) {
  return Buffer.from(
    await (await request("object/xiamu-backups/" + key)).arrayBuffer(),
  );
}
const exerciseIsolation = process.argv.includes("--isolation");
(async () => {
  let probe;
  try {
    const jobs = await pg(
        "maintenance_backup_jobs?status=eq.complete&order=snapshot_at.desc&limit=1",
      ),
      job = jobs[0];
    assert.ok(job);
    const marker = JSON.parse(
      (await object("daily/" + job.day + "/complete.json")).toString("utf8"),
    );
    assert.equal(marker.jobId, job.id);
    const manifestBytes = await object(marker.manifestKey);
    assert.equal(hash(manifestBytes), marker.manifestSha);
    assert.equal(marker.manifestSha, job.manifest_sha);
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    const staging = await pg(
      "maintenance_backup_rows?job_id=eq." + job.id + "&select=seq&limit=1",
    );
    assert.equal(
      staging.length,
      0,
      "归档完成后PG临时快照已清掉；本演练必须从云存储恢复",
    );
    const previous = (
      await pg("maintenance_restore_runs?order=created_at.desc&limit=1")
    )[0];
    const completedFile = path.join(local, "maintenance-restore-results.json");
    const completed = fs.existsSync(completedFile)
      ? JSON.parse(fs.readFileSync(completedFile))
      : null;
    const run =
      previous?.manifest?.jobId === manifest.jobId &&
      !(completed?.passed && completed.runId === previous.id)
        ? previous
        : await rpc("api_maintenance_restore", {
            p_action: "begin",
            p_run: null,
            p_data: { manifest },
          });
    assert.match(run.id, /^[a-f0-9-]{36}$/);
    const dir = path.join(local, "restore-" + run.id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, "manifest.json"), manifestBytes, {
      mode: 0o600,
    });
    const result = {
      checks: [],
      runId: run.id,
      backupJobId: job.id,
      tables: manifest.tables.length,
      rows: manifest.tables.reduce((n, t) => n + Number(t.rows), 0),
      externalFiles: manifest.externalFiles.length,
    };
    if (
      exerciseIsolation &&
      fs.existsSync(path.join(local, "maintenance-isolation-probe.json"))
    ) {
      probe = privateJSON("maintenance-isolation-probe");
      const current = (
        await pg("staff?id=eq." + probe.staffId + "&select=name,version")
      )[0];
      if (current.name === probe.oldName) {
        const { call } = source();
        await call(
          probe.who,
          "staff-admin",
          "/staff/" + probe.staffId,
          "PATCH",
          {
            name: "备份快照后隔离变更",
            version: current.version,
            reason: "继续验证从云归档恢复不会混入快照后的真实变更",
          },
        );
      }
    }
    const parts = manifest.parts.filter((p) => p.kind === "data");
    let tamperChecked = false,
      staffSnapshot;
    for (const part of parts) {
      const compressed = await object(part.key);
      assert.equal(hash(compressed), part.gzipSha256, "归档gzip摘要匹配");
      const payload = zlib.gunzipSync(compressed);
      assert.equal(hash(payload), part.sha256, "原始PG文本摘要匹配");
      fs.writeFileSync(
        path.join(dir, part.table + "-" + path.basename(part.key)),
        compressed,
        { mode: 0o600 },
      );
      if (!tamperChecked) {
        const before = (
          await pg("maintenance_restore_chunks?run_id=eq." + run.id)
        ).length;
        await assert.rejects(
          rpc("api_maintenance_restore", {
            p_action: "chunk",
            p_run: run.id,
            p_data: { key: part.key, payload: payload.toString("utf8") + " " },
          }),
          (e) => e.pgCode === "DATABASE_P0400",
        );
        assert.equal(
          (await pg("maintenance_restore_chunks?run_id=eq." + run.id)).length,
          before,
        );
        tamperChecked = true;
      }
      const data = { key: part.key, payload: payload.toString("utf8") };
      await rpc("api_maintenance_restore", {
        p_action: "chunk",
        p_run: run.id,
        p_data: data,
      });
      const replay = await rpc("api_maintenance_restore", {
        p_action: "chunk",
        p_run: run.id,
        p_data: data,
      });
      assert.equal(replay.replayed, true);
      if (
        exerciseIsolation &&
        part.table === "staff" &&
        fs.existsSync(path.join(local, "maintenance-isolation-probe.json"))
      ) {
        probe = privateJSON("maintenance-isolation-probe");
        staffSnapshot = JSON.parse(data.payload).rows.find(
          (r) => r.id === probe.staffId,
        );
      }
    }
    result.checks.push(
      "从真实私有云存储下载数据分片，逐片校验压缩/原文SHA256；篡改拒绝且不入库，重复分片不重复插入",
    );
    const verified = await rpc("api_maintenance_restore", {
      p_action: "verify",
      p_run: run.id,
      p_data: {},
    });
    assert.equal(verified.status, "verified");
    assert.deepEqual(verified.totals, manifest.totals);
    assert.equal(verified.tables.length, manifest.tables.length);
    assert.equal(verified.foreignKeysValidated, true);
    assert.equal(verified.sequencesIsolated, true);
    result.totals = verified.totals;
    result.foreignKeys = manifest.tables.reduce(
      (n, t) => n + t.foreignKeys.length,
      0,
    );
    result.checks.push(
      "全部表行数与每行完整数据摘要一致，实际建立/校验外键，库存成本/销售/退款/代理收益对账，序列只在隔离schema推进",
    );
    if (probe) {
      assert.equal(staffSnapshot.name, probe.oldName);
      assert.notEqual(
        (await pg("staff?id=eq." + probe.staffId + "&select=name"))[0].name,
        probe.oldName,
      );
      result.snapshotIsolationVerified = true;
      result.checks.push(
        "快照后真实员工变更及新审计未混入归档，隔离恢复得到快照时旧值",
      );
    }
    const media = manifest.parts.filter((p) => p.kind === "media");
    let cloudMedia;
    for (let i = 0; i < 80; i++) {
      const response = await invoke({ restoreRun: run.id });
      cloudMedia = response.data;
      if (cloudMedia.restoreMediaComplete) break;
      console.log("Cloud media verification progressed:", i + 1);
    }
    assert.equal(
      cloudMedia.restoreMediaComplete,
      true,
      "全部媒体须在云内逐字节校验完成",
    );
    assert.equal(cloudMedia.files, media.length);
    const mediaStates = await pg(
      "maintenance_restore_media?run_id=eq." +
        run.id +
        "&select=status,actual_sha,expected_sha,offset_bytes,byte_size&limit=10000",
    );
    assert.equal(mediaStates.length, media.length);
    assert.ok(
      mediaStates.every(
        (m) =>
          m.status === "verified" &&
          m.actual_sha === m.expected_sha &&
          m.offset_bytes === m.byte_size,
      ),
    );
    result.mediaFiles = cloudMedia.files;
    result.mediaBytes = cloudMedia.bytes;
    result.mediaVerification = "cloud-copy-and-full-ranged-sha256";
    result.checks.push(
      "全部已管理云媒体从备份复制到隔离目录，在真实云函数内分段读取每个字节核对完整SHA256；旧未迁移引用单列",
    );
    result.passed = true;
    save("maintenance-restore-results", result);
    console.log(JSON.stringify(result));
  } finally {
    if (
      exerciseIsolation &&
      !probe &&
      fs.existsSync(path.join(local, "maintenance-isolation-probe.json"))
    )
      probe = privateJSON("maintenance-isolation-probe");
    if (probe) {
      const row = (
        await pg("staff?id=eq." + probe.staffId + "&select=name,version")
      )[0];
      if (row.name !== probe.oldName) {
        const { call } = source();
        await call(
          probe.who,
          "staff-admin",
          "/staff/" + probe.staffId,
          "PATCH",
          {
            name: probe.oldName,
            version: row.version,
            reason: "恢复一致性快照验证前的隔离员工姓名",
          },
        );
      }
      const restored = (
        await pg("staff?id=eq." + probe.staffId + "&select=name")
      )[0];
      assert.equal(restored.name, probe.oldName);
      save("maintenance-isolation-restored", { restored: true });
    }
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
