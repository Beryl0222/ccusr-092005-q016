import assert from "node:assert/strict";
import { loadSeed } from "../src/seed.js";
import { MissionBackend } from "../src/backend.js";
import { createStore } from "../src/store.js";

/** 断言 fn 以指定业务错误码拒绝（错误消息是中文，断言应对码而非文案）。 */
export function throwsCode(fn, code) {
  let err;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  assert.ok(err, `预期抛出 ${code}，但未抛出`);
  assert.equal(err.code, code, `错误码应为 ${code}，实际为 ${err.code}（${err.message}）`);
}

/** 固定起点、每分钟递增的时钟，保证链路时间可排序、断言稳定。 */
export function fakeClock(startIso = "2026-09-28T08:00:00.000Z") {
  let t = Date.parse(startIso);
  return () => {
    const iso = new Date(t).toISOString();
    t += 60_000;
    return iso;
  };
}

export async function makeBackend() {
  const seed = await loadSeed("fixtures/seed.json");
  const store = createStore();
  const clock = fakeClock();
  const backend = new MissionBackend(seed, { store, clock });
  return { backend, seed, clock };
}

export const M = "mission-fiji-2026";

export const ids = {
  or1: "room-or-1",
  or2: "room-or-2",
  phaco1: "eq-phaco-01",
  phaco2: "eq-phaco-02",
  scope1: "eq-microscope-01",
  scope2: "eq-microscope-02",
  iol: "cons-iol",
  visc: "cons-visc",
  pack: "cons-pack",
  device3: "device-chongming-03",
  device7: "device-chongming-07",
  hospital: "hospital-cwm",
  hospitalNadi: "hospital-nadi",
  // 中方
  chen: "staff-chen", // 医生
  lin: "staff-lin", // 护士
  wang: "staff-wang", // 任务负责人/协调员
  // 本地医院
  singh: "staff-singh", // 医生
  ana: "staff-ana", // 护士
  jonasa: "staff-jonasa", // 协调员/联络人
  // 其他任务/未授权医院
  other: "staff-other",
  ram: "staff-ram",
};

/** 走完 筛查→图像→复核→同意 的标准前置，返回 patientId。 */
export function admitCandidate(backend, { decision = "eligible", reason = "", localName = "Josefa Bole", village = "Nausori" } = {}) {
  const reg = backend.registerScreening({
    missionId: M,
    batchId: "batch-A",
    localName,
    village,
    verifierId: ids.jonasa,
    registeredBy: ids.ana,
    deviceId: ids.device3,
  });
  backend.syncImageSummary({
    missionId: M,
    batchId: "batch-A",
    deviceId: ids.device3,
    patientId: reg.patientId,
    contentHash: `hash-${localName}`,
    assistSuggestion: { condition: "cataract", confidence: 0.81 },
    clientSyncId: `sync-${localName}`,
    actorId: ids.ana,
  });
  backend.reviewPatient({
    missionId: M,
    patientId: reg.patientId,
    doctorId: ids.chen,
    decision,
    reason,
  });
  backend.recordConsent({
    missionId: M,
    patientId: reg.patientId,
    memberId: ids.lin,
    languageVersion: "fj",
    witnessId: ids.jonasa,
  });
  return reg.patientId;
}
