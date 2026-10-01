import assert from "node:assert/strict";
import test from "node:test";

import { makeBackend, M, ids, admitCandidate, throwsCode } from "./helpers.js";

test("患者以当地可核验别名进入筛查批次，重复登记不产生第二例", async () => {
  const { backend } = await makeBackend();

  const first = backend.registerScreening({
    missionId: M,
    batchId: "batch-A",
    localName: "Josefa Bole",
    village: "Nausori",
    verifierId: ids.jonasa,
    registeredBy: ids.ana,
    deviceId: ids.device3,
  });

  // 另一台设备、另一批次，离线多点重复登记同一人
  const again = backend.registerScreening({
    missionId: M,
    batchId: "batch-B",
    localName: "  josefa   bole ", // 大小写/空格差异
    village: "nausori",
    verifierId: ids.jonasa,
    registeredBy: ids.ana,
    deviceId: ids.device7,
  });

  assert.equal(again.patientId, first.patientId);
  assert.equal(Object.keys(backend.state.patients).length, 1);
  const patient = backend.state.patients[first.patientId];
  assert.equal(patient.contacts.length, 2, "两次接触都应保留在同一档案");
  assert.ok(patient.aliases[0].verified_by === ids.jonasa, "别名必须有当地核验人");
});

test("同名不同村视为不同患者；同任务不同语言别名可并存", async () => {
  const { backend } = await makeBackend();

  const a = backend.registerScreening({
    missionId: M, batchId: "b1", localName: "Ana", village: "Nausori",
    verifierId: ids.jonasa, registeredBy: ids.ana,
  });
  const b = backend.registerScreening({
    missionId: M, batchId: "b1", localName: "Ana", village: "Lami",
    verifierId: ids.jonasa, registeredBy: ids.ana,
  });
  assert.notEqual(a.patientId, b.patientId);

  // 同一人后续提供印地语译名，应追加别名而不是新建
  backend.registerScreening({
    missionId: M, batchId: "b2", localName: "Ana", village: "Nausori", locale: "hi",
    verifierId: ids.jonasa, registeredBy: ids.ana,
  });
  assert.equal(Object.keys(backend.state.patients).length, 2);
  assert.equal(backend.state.patients[a.patientId].aliases.length, 2);
});

test("离线图像联网后按内容哈希去重合并，重复同步幂等", async () => {
  const { backend } = await makeBackend();
  const pid = admitCandidate(backend, { localName: "Wati" });

  // admitCandidate 已同步一次；这里模拟设备断网重传同一 clientSyncId
  const replay = backend.syncImageSummary({
    missionId: M, batchId: "batch-A", deviceId: ids.device3, patientId: pid,
    contentHash: "hash-Wati", assistSuggestion: { condition: "cataract" },
    clientSyncId: "sync-Wati", actorId: ids.ana,
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.merged, false, "幂等重放不应走合并逻辑");

  // 另一台设备因患者转点重拍产生相同内容哈希 → 合并，不新增图像
  const merged = backend.syncImageSummary({
    missionId: M, batchId: "batch-C", deviceId: ids.device7, patientId: pid,
    contentHash: "hash-Wati", clientSyncId: "sync-Wati-device7", actorId: ids.ana,
  });
  assert.equal(merged.merged, true);
  assert.equal(merged.imageId, replay.imageId);
  assert.equal(backend.state.patients[pid].image_ids.length, 1);
  assert.equal(backend.state.images[merged.imageId].sources.length, 2);
  assert.equal(backend.state.images[merged.imageId].sync_count, 2);
});

test("辅助判断不改变患者状态，只有医生复核才进入候选治疗路径", async () => {
  const { backend } = await makeBackend();
  const reg = backend.registerScreening({
    missionId: M, batchId: "batch-A", localName: "Kitione", village: "Suva",
    verifierId: ids.jonasa, registeredBy: ids.ana, deviceId: ids.device3,
  });
  backend.syncImageSummary({
    missionId: M, batchId: "batch-A", deviceId: ids.device3, patientId: reg.patientId,
    contentHash: "h-kitione", assistSuggestion: { condition: "cataract", confidence: 0.99 },
    clientSyncId: "s1", actorId: ids.ana,
  });
  assert.equal(backend.state.patients[reg.patientId].status, "screened");
  assert.equal(backend.state.images[Object.values(backend.state.images)[0].id].assist_status, "advisory_only");

  // 护士不能复核
  throwsCode(
    () => backend.reviewPatient({ missionId: M, patientId: reg.patientId, doctorId: ids.lin, decision: "eligible" }),
    "ROLE_DENIED",
  );

  const review = backend.reviewPatient({
    missionId: M, patientId: reg.patientId, doctorId: ids.chen, decision: "eligible",
  });
  assert.equal(backend.state.patients[reg.patientId].status, "candidate");

  // 不能重复做出人工决定
  throwsCode(
    () => backend.reviewPatient({ missionId: M, patientId: reg.patientId, doctorId: ids.singh, decision: "eligible" }),
    "ALREADY_REVIEWED",
  );
  assert.equal(review.doctor_id, ids.chen);
});

test("绿色通道复核必须记录理由", async () => {
  const { backend } = await makeBackend();
  const pid = admitCandidate(backend, { decision: "eligible", localName: "P1" });
  assert.ok(pid); // admitCandidate 内部对 eligible 已验证可走通

  const reg = backend.registerScreening({
    missionId: M, batchId: "b", localName: "P2", village: "V2",
    verifierId: ids.jonasa, registeredBy: ids.ana,
  });
  backend.syncImageSummary({
    missionId: M, batchId: "b", deviceId: ids.device3, patientId: reg.patientId,
    contentHash: "h-p2", clientSyncId: "s-p2", actorId: ids.ana,
  });
  assert.throws(
    () => backend.reviewPatient({ missionId: M, patientId: reg.patientId, doctorId: ids.chen, decision: "green_channel" }),
    /绿色通道必须记录理由/,
  );
});

test("observe 后病情变化可由医生重新复核为候选，eligible 决定仍不可重复", async () => {
  const { backend } = await makeBackend();
  const reg = backend.registerScreening({
    missionId: M, batchId: "b", localName: "ReReview", village: "V",
    verifierId: ids.jonasa, registeredBy: ids.ana, deviceId: ids.device3,
  });
  backend.syncImageSummary({
    missionId: M, batchId: "b", deviceId: ids.device3, patientId: reg.patientId,
    contentHash: "h-rereview", clientSyncId: "s-rereview", actorId: ids.ana,
  });
  backend.reviewPatient({ missionId: M, patientId: reg.patientId, doctorId: ids.singh, decision: "observe", reason: "暂不满足" });
  assert.equal(backend.state.patients[reg.patientId].status, "review_observe");
  const oldReviewId = backend.state.patients[reg.patientId].review_id;

  // 病情进展，陈医生重新复核为候选，原决定被标记 supersedes
  const second = backend.reviewPatient({
    missionId: M, patientId: reg.patientId, doctorId: ids.chen,
    decision: "eligible", reason: "视力进一步下降，符合手术指征",
  });
  assert.equal(second.supersedes, oldReviewId, "新复核应指向被替代的旧复核");
  assert.equal(backend.state.patients[reg.patientId].status, "candidate");

  // 已入候选后不能再重复决定
  throwsCode(
    () => backend.reviewPatient({ missionId: M, patientId: reg.patientId, doctorId: ids.chen, decision: "eligible" }),
    "ALREADY_REVIEWED",
  );
});

test("知情同意保存语言版本与见证人，见证人不能是登记人本人", async () => {
  const { backend } = await makeBackend();

  const reg = backend.registerScreening({
    missionId: M, batchId: "batch-A", localName: "Mere", village: "Nasinu",
    verifierId: ids.jonasa, registeredBy: ids.ana, deviceId: ids.device3,
  });
  backend.syncImageSummary({
    missionId: M, batchId: "batch-A", deviceId: ids.device3, patientId: reg.patientId,
    contentHash: "h-mere", clientSyncId: "s-mere", actorId: ids.ana,
  });
  backend.reviewPatient({ missionId: M, patientId: reg.patientId, doctorId: ids.chen, decision: "eligible" });

  assert.throws(
    () => backend.recordConsent({
      missionId: M, patientId: reg.patientId, memberId: ids.lin,
      languageVersion: "fj", witnessId: ids.lin, // 本人见证
    }),
    /见证人不能是登记人本人/,
  );

  const consent = backend.recordConsent({
    missionId: M, patientId: reg.patientId, memberId: ids.lin,
    languageVersion: "fj-Latn-fiji-2026", witnessId: ids.jonasa, signatureType: "thumbprint",
  });
  assert.equal(consent.language_version, "fj-Latn-fiji-2026");
  assert.equal(consent.witness_id, ids.jonasa);
  assert.equal(consent.signature_type, "thumbprint");

  // 未复核为候选的患者不能签治疗同意
  const reg2 = backend.registerScreening({
    missionId: M, batchId: "batch-A", localName: "NoGo", village: "Nasinu",
    verifierId: ids.jonasa, registeredBy: ids.ana,
  });
  throwsCode(
    () => backend.recordConsent({
      missionId: M, patientId: reg2.patientId, memberId: ids.lin,
      languageVersion: "fj", witnessId: ids.jonasa,
    }),
    "NOT_CANDIDATE",
  );
});
