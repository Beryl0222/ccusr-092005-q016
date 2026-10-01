import { rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * 内存状态 + 可选 JSON 文件持久化（原子写）。
 * 所有领域集合集中在 state 中，便于整体快照与测试断言。
 */
export function createStore() {
  const state = {
    missions: {}, // missionId -> 任务运行期状态（status、关闭信息）
    patients: {}, // patientId
    batches: {}, // batchId -> 筛查批次
    images: {}, // imageId -> 图像摘要（合并后只保留一条主记录）
    reviews: {}, // reviewId -> 医生人工决定
    consents: {}, // consentId -> 知情同意
    treatments: {}, // treatmentId -> 治疗（每例患者至多一条）
    referrals: {}, // referralId -> 转介
    slots: {}, // slotId -> 资源时段锁定
    consumptions: {}, // consumableId -> { used, holds: {slotId: qty} }
    handovers: {}, // handoverId -> 交接授权
    equipment_faults: [], // 设备故障登记
    audit: [], // 审计事件（追加）
  };

  // 幂等与去重索引：键在各自作用域内唯一
  const idempotency = new Map(); // 客户端同步键 -> 首次结果
  const aliasIndex = new Map(); // `${missionId}|${locale}|${normalized}` -> patientId
  const imageHashIndex = new Map(); // `${missionId}|${deviceId}|${contentHash}` -> imageId

  const listeners = [];

  return {
    state,
    idempotency,
    aliasIndex,
    imageHashIndex,
    listeners,

    onPersist(fn) {
      listeners.push(fn);
    },

    async persist() {
      for (const fn of listeners) await fn(state);
    },

    /**
     * 幂等执行：同一 key 重复提交直接返回首次结果，不产生副作用。
     * fn 必须返回可 JSON 序列化的结果。
     */
    runIdempotent(key, fn) {
      if (idempotency.has(key)) {
        return { ...idempotency.get(key), replayed: true };
      }
      const result = fn();
      idempotency.set(key, result);
      return { ...result, replayed: false };
    },

    /**
     * 用磁盘快照重建运行态（任务重启后恢复）。
     * 幂等索引按档案内容重建；同步级幂等表不持久化，
     * 重放由业务唯一键（patient.treatment_id、图像内容哈希）继续兜底。
     */
    hydrate(snapshot) {
      for (const key of ["patients", "batches", "images", "reviews", "consents", "treatments", "referrals", "slots", "consumptions", "handovers"]) {
        if (snapshot[key]) this.state[key] = snapshot[key];
      }
      if (snapshot.missions) Object.assign(this.state.missions, snapshot.missions);
      if (Array.isArray(snapshot.equipment_faults)) this.state.equipment_faults = snapshot.equipment_faults;
      if (Array.isArray(snapshot.audit)) this.state.audit = snapshot.audit;

      aliasIndex.clear();
      imageHashIndex.clear();
      const norm = (s) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
      for (const p of Object.values(this.state.patients)) {
        for (const a of p.aliases ?? []) {
          aliasIndex.set(`${p.missionId}|${norm(a.local_name)}|${norm(a.village)}`, p.id);
        }
      }
      for (const img of Object.values(this.state.images)) {
        imageHashIndex.set(`${img.missionId}|${img.patient_id}|${img.content_hash}`, img.id);
      }
    },
  };
}

/** 原子写持久化监听器：先写临时文件再 rename，避免半截文件。 */
export function atomicJsonFile(filePath) {
  let chain = Promise.resolve();
  return async (state) => {
    chain = chain.then(async () => {
      const base = filePath.split("/").pop();
      const tmp = join(
        dirname(filePath),
        `.${base}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      );
      await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
      await rename(tmp, filePath);
    });
    return chain;
  };
}
