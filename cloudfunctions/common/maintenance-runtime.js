/** 内部定时备份/清理。只接收部署产生的定时器能力名；不接收客户端表名、对象名或SQL。 */
const crypto = require("node:crypto"),
  zlib = require("node:zlib");
const { rpc, fail, secret } = require("./gateway"),
  storage = require("./pg-storage");
const bucket = "xiamu-backups",
  sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const triggerName = () =>
  "maintenance-" +
  crypto
    .createHmac("sha256", secret("MAINTENANCE_KEY"))
    .update("timer-v1")
    .digest("hex")
    .slice(0, 32);
function allowed(event, wx) {
  return (
    !wx?.OPENID &&
    event?.Type === "Timer" &&
    typeof event.TriggerName === "string" &&
    event.TriggerName === triggerName()
  );
}
function day(now = Date.now()) {
  return new Date(now + 6 * 3600000).toISOString().slice(0, 10);
}
function safeBackupKey(key) {
  return /^daily\/\d{4}-\d{2}-\d{2}\/(?:[a-f0-9-]{36}\/(?:tables\/[a-z_]+\/\d+\.json\.gz|media\/[a-f0-9-]{36}|manifest\.json)|complete\.json)$/.test(
    key,
  );
}
async function bytesFrom(bucket, key) {
  const r = await storage.request("object/" + storage.objectPath(bucket, key));
  if (!r.ok) fail(503, "备份对象读取失败");
  return Buffer.from(await r.arrayBuffer());
}
async function put(key, bytes, mime = "application/json") {
  if (
    !safeBackupKey(key) &&
    !/^maintenance\/\d{4}-\d{2}-\d{2}\/gc-complete\.json$/.test(key)
  )
    fail(400, "备份对象路径无效");
  if (bytes.length > 16 * 1024 * 1024)
    fail(503, "备份分片过大，需调整分片或异步任务容量");
  if (await storage.info(bucket, key)) {
    const stored = await bytesFrom(bucket, key);
    if (sha(stored) !== sha(bytes))
      fail(409, "已有备份对象内容不一致，拒绝覆盖");
    return;
  }
  const upload = await storage.json(
      "object/upload/sign/" + storage.objectPath(bucket, key),
      { headers: { "x-upsert": "false" } },
    ),
    url =
      upload.fullURL ||
      (upload.url ? new URL(upload.url, storage.origin()).href : null);
  if (!url) fail(503, "备份上传签名无效");
  const r = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": mime },
    body: bytes,
    signal: AbortSignal.timeout(4000),
  });
  if (!r.ok) {
    if (r.status === 409) {
      const b = await bytesFrom(bucket, key);
      if (sha(b) === sha(bytes)) return;
    }
    fail(503, "备份对象写入失败");
  }
  if (sha(await bytesFrom(bucket, key)) !== sha(bytes))
    fail(503, "备份对象写入后校验不一致");
}
async function processBackupTask(task) {
  if (task.kind === "media") {
    const m =
      /^(xiamu-(?:public|internal))\/([a-f0-9-]{36}(?:-[a-f0-9-]{36})?)$/.exec(
        task.source || "",
      );
    if (
      !m ||
      !safeBackupKey(task.key) ||
      !Number.isInteger(Number(task.size)) ||
      Number(task.size) < 1 ||
      !/^[a-f0-9]{64}$/.test(task.sha256 || "")
    )
      fail(503, "已登记云文件的备份元数据无效");
    await storage.copy(m[1], m[2], bucket, task.key, task.mime);
    const info = await storage.info(bucket, task.key);
    if (Number(info?.size) !== Number(task.size))
      fail(503, "备份文件实际大小不一致");
    return { id: task.id, bytes: Number(task.size), sha256: task.sha256 };
  }
  const raw = Buffer.from(task.payload, "utf8");
  if (raw.length > 16 * 1024 * 1024) fail(503, "备份单分片超过16MB，拒绝截断");
  const bytes = task.kind === "data" ? zlib.gzipSync(raw) : raw;
  await put(
    task.key,
    bytes,
    task.kind === "data" ? "application/gzip" : "application/json",
  );
  return {
    id: task.id,
    sha256: sha(raw),
    gzipSha256: task.kind === "data" ? sha(bytes) : null,
    bytes: bytes.length,
    rawBytes: raw.length,
    rows: task.rows || 0,
  };
}
async function backupStep(targetDay) {
  const batch = await rpc("api_maintenance_backup", {
    p_action: "take",
    p_data: { day: targetDay },
  });
  if (batch.status === "failed")
    fail(503, "今日备份已失败，请检查维护日志并处理后重试");
  if (batch.status === "busy") return { busy: true };
  if (batch.status === "complete") {
    const key = "daily/" + batch.day + "/" + batch.jobId + "/manifest.json",
      body = await bytesFrom(bucket, key);
    if (sha(body) !== batch.manifestSha)
      fail(503, "备份清单对象与数据库摘要不一致");
    const marker = {
      format: "xiamu-backup-marker-v1",
      jobId: batch.jobId,
      day: batch.day,
      manifestKey: key,
      manifestSha: batch.manifestSha,
    };
    await put(
      "daily/" + batch.day + "/complete.json",
      Buffer.from(JSON.stringify(marker)),
    );
    await rpc("api_maintenance_backup", {
      p_action: "marker",
      p_data: { jobId: batch.jobId, manifestSha: batch.manifestSha },
    });
    return { complete: batch.day === targetDay };
  }
  const settled = await Promise.allSettled(batch.tasks.map(processBackupTask)),
    results = settled
      .filter((x) => x.status === "fulfilled")
      .map((x) => x.value);
  try {
    if (results.length)
      await rpc("api_maintenance_backup", {
        p_action: "ack",
        p_data: { jobId: batch.jobId, lease: batch.lease, results },
      });
    const error = settled.find((x) => x.status === "rejected");
    if (error) {
      // ack会释放租约，下一轮仍从未完成任务继续。失败计数只在没有任何成功时提交。
      if (!results.length)
        await rpc("api_maintenance_backup", {
          p_action: "fail",
          p_data: {
            jobId: batch.jobId,
            lease: batch.lease,
            message: "备份对象处理失败",
          },
        });
      throw error.reason;
    }
  } catch (e) {
    throw e;
  }
  return { tasks: results.length };
}
async function gcStep() {
  const batch = await rpc("api_maintenance_gc", {
    p_action: "take",
    p_data: {},
  });
  if (!batch.tasks.length) return { complete: !batch.more };
  const settled = await Promise.allSettled(
    batch.tasks.map(async (task) => {
      const auth = await rpc("api_maintenance_gc", {
        p_action: "authorize",
        p_data: { id: task.id, lease: task.lease },
      });
      if (!auth.allowed) {
        await rpc("api_maintenance_gc", {
          p_action: "ack",
          p_data: { id: task.id, lease: task.lease, skipped: true },
        });
        return 0;
      }
      try {
        const r = await storage.request(
          "object/" + storage.objectPath(task.bucket, task.key),
          { method: "DELETE" },
        );
        if (!r.ok && r.status !== 404)
          fail(503, "过期对象删除失败，未标记成功");
        await rpc("api_maintenance_gc", {
          p_action: "ack",
          p_data: { id: task.id, lease: task.lease },
        });
        return 1;
      } catch (e) {
        await rpc("api_maintenance_gc", {
          p_action: "fail",
          p_data: {
            id: task.id,
            lease: task.lease,
            message: "云存储删除失败，稍后重试",
          },
        }).catch(() => {});
        throw e;
      }
    }),
  );
  const error = settled.find((x) => x.status === "rejected");
  if (error) throw error.reason;
  return { deleted: settled.reduce((n, x) => n + x.value, 0) };
}
async function restoreMediaStep(runId) {
  const data = { p_run: runId },
    task = await rpc("api_maintenance_restore_media", {
      p_action: "take",
      ...data,
      p_data: {},
    });
  if (task.complete || task.busy) return task;
  if (
    !safeBackupKey(task.key) ||
    !/^restore\/[a-f0-9-]{36}\/media\/[a-f0-9-]{36}$/.test(task.target)
  )
    fail(400, "恢复媒体路径无效");
  try {
    await storage.copy(bucket, task.key, bucket, task.target);
    const info = await storage.info(bucket, task.target);
    if (Number(info?.size) !== Number(task.size))
      fail(503, "恢复媒体副本大小不一致");
    const { createSHA256 } = require("hash-wasm"),
      hasher = await createSHA256();
    if (task.hashState) hasher.load(Buffer.from(task.hashState, "base64"));
    else hasher.init();
    const chunk = await storage.readChunk(
      bucket,
      task.target,
      Number(task.offset),
      Number(task.size),
    );
    hasher.update(chunk);
    const next = Number(task.offset) + chunk.length,
      finished = next === Number(task.size),
      state = Buffer.from(hasher.save()).toString("base64");
    await rpc("api_maintenance_restore_media", {
      p_action: "progress",
      ...data,
      p_data: {
        key: task.key,
        lease: task.lease,
        from: task.offset,
        offset: next,
        hashState: state,
        ...(finished ? { sha256: hasher.digest("hex") } : {}),
      },
    });
    return { complete: false, bytes: chunk.length };
  } catch (e) {
    await rpc("api_maintenance_restore_media", {
      p_action: "fail",
      ...data,
      p_data: { key: task.key, lease: task.lease },
    }).catch(() => {});
    throw e;
  }
}
async function run(event, wx) {
  if (!allowed(event, wx))
    return { code: 403, data: null, message: "仅内部定时任务可调用" };
  if (event.RestoreRun !== undefined) {
    if (
      typeof event.RestoreRun !== "string" ||
      !/^[a-f0-9-]{36}$/.test(event.RestoreRun)
    )
      fail(400, "恢复演练编号无效");
    const end = Date.now() + 4000;
    let bytes = 0;
    while (Date.now() < end) {
      const r = await restoreMediaStep(event.RestoreRun);
      if (r.complete)
        return {
          code: 0,
          data: { restoreMediaComplete: true, files: r.files, bytes: r.bytes },
          message: "ok",
        };
      if (r.busy) break;
      bytes += r.bytes || 0;
    }
    return {
      code: 0,
      data: { restoreMediaComplete: false, processedBytes: bytes },
      message: "ok",
    };
  }
  const targetDay = day(),
    marker = "daily/" + targetDay + "/complete.json",
    gcMarker = "maintenance/" + targetDay + "/gc-complete.json";
  let backupComplete = !!(await storage.info(bucket, marker)),
    gcComplete = !event.RecheckGC && !!(await storage.info(bucket, gcMarker));
  const end = Date.now() + 4000;
  let tasks = 0,
    deleted = 0;
  while (Date.now() < end) {
    if (!backupComplete) {
      const r = await backupStep(targetDay);
      tasks += r.tasks || 0;
      backupComplete = !!r.complete;
      if (r.busy) break;
    } else if (!gcComplete) {
      const r = await gcStep();
      deleted += r.deleted || 0;
      if (r.complete) {
        await put(
          gcMarker,
          Buffer.from(
            JSON.stringify({
              day: targetDay,
              policy: "expired-24h-backup-30d-v1",
            }),
          ),
        );
        gcComplete = true;
      }
    } else break;
  }
  return {
    code: 0,
    data: { day: targetDay, backupComplete, gcComplete, tasks, deleted },
    message: "ok",
  };
}
module.exports = {
  run,
  day,
  allowed,
  triggerName,
  safeBackupKey,
  backupStep,
  gcStep,
  restoreMediaStep,
  put,
  bytesFrom,
  sha,
};
