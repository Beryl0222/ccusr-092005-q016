import assert from "node:assert/strict";
import test from "node:test";

import { MissionBackend, DomainError } from "../src/backend.js";
import { setupFromSeed } from "../src/setup.js";
import { restoreByAlias, continuityAudit } from "../src/timeline.js";

const MISSION = "mission-fiji-2026";
const DEVICE = "device-chongming-03";
const DEVICE2 = "device-chongming-07";
const PHACO = "device-phaco-01";

const expectError = (code) => (err) => err instanceof DomainError && err.code === code;

function batchRow({ rowId, alias, hash, assist, verifier }) {
  return {
    clientRowId: rowId,
    alias,
    proofType: "community_roster",
    proofRef: `CR-${rowId}`,
    verifiedBy: verifier ?? "staff-fj-nurse",
    capturedAt: "2026-09-25T08:00:00Z",
    images: [{ contentHash: hash, summary: "晶状体混浊，眼底窥不清", assistVerdict: assist }],
  };
}

async function fresh() {
  return setupFromSeed();
}

function findSlot(app, { roomId, date, index }) {
  return [...app.slots.values()].find((s) => s.roomId === roomId && s.date === date && s.index === index);
}

function slotOfBooking(app, bookingId) {
  return [...app.slots.values()].find((s) => s.booking?.id === bookingId);
}

test("离线批次：同一图像摘要跨设备去重合并，重复同步不产生第二例", async () => {
  const { app } = await fresh();
  const row = batchRow({ rowId: "r-1", alias: "Apenisa", hash: "sha256:img-aaa", assist: "白内障：建议手术" });

  const first = app.syncScreeningBatch({ missionId: MISSION, deviceId: DEVICE, batchClientId: "batch-01", rows: [row] });
  assert.equal(first.duplicated, false);
  assert.equal(first.mergedFindings.length, 1);

  // 另一台设备离线采集到同一图像（相同内容指纹），联网回传只合并来源。
  const second = app.syncScreeningBatch({ missionId: MISSION, deviceId: DEVICE2, batchClientId: "batch-02", rows: [row] });
  assert.equal(second.mergedFindings.length, 1);
  assert.deepEqual(second.mergedFindings[0].sources.map((s) => s.deviceId).sort(), [DEVICE, DEVICE2]);
  assert.equal(app.findings.size, 1);
  assert.equal(app.patients.size, 1, "同一可核验别名不得另建患者");

  // 网络抖动导致同一批次重放：原样返回，不新增任何记录。
  const replay = app.syncScreeningBatch({ missionId: MISSION, deviceId: DEVICE, batchClientId: "batch-01", rows: [row] });
  assert.equal(replay.duplicated, true);
  assert.equal(app.findings.size, 1);
  assert.equal(app.batches.size, 2);
});

test("无凭证别名拒绝入批；辅助判断本身不能进入治疗路径", async () => {
  const { app } = await fresh();
  assert.throws(
    () => app.registerPatient({ missionId: MISSION, alias: "Unknown", verifiedBy: "staff-fj-nurse" }),
    expectError("ALIAS_UNVERIFIABLE"),
  );

  app.syncScreeningBatch({
    missionId: MISSION,
    deviceId: DEVICE,
    batchClientId: "batch-x",
    rows: [batchRow({ rowId: "r-x", alias: "Mereani", hash: "h-x", assist: "白内障：建议手术" })],
  });
  const patient = app.resolveByAlias(MISSION, "Mereani");
  assert.equal(patient.status, "screened");

  const slot = findSlot(app, { roomId: "or-cwm-1", date: "2026-09-26", index: 0 });
  assert.throws(
    () => app.lockSlot({ slotId: slot.id, patientId: patient.id, staffIds: ["staff-cn-surgeon"] }),
    expectError("NOT_CANDIDATE"),
  );

  // 护士不能替代医生复核。
  assert.throws(
    () => app.reviewByDoctor({ patientId: patient.id, reviewerId: "staff-cn-nurse", decision: "candidate" }),
    expectError("DOCTOR_ONLY"),
  );

  app.reviewByDoctor({ patientId: patient.id, reviewerId: "staff-cn-lead", decision: "candidate", note: "年龄相关性白内障，拟手术" });
  assert.equal(patient.status, "candidate");
});

test("人员/设备/耗材按时段锁定，冲突与缺货被拒绝", async () => {
  const { app } = await fresh();
  const p1 = app.registerPatient({ missionId: MISSION, alias: "P1", proofType: "community_roster", proofRef: "CR-P1", verifiedBy: "staff-fj-nurse" }).patient;
  const p2 = app.registerPatient({ missionId: MISSION, alias: "P2", proofType: "community_roster", proofRef: "CR-P2", verifiedBy: "staff-fj-nurse" }).patient;
  app.reviewByDoctor({ patientId: p1.id, reviewerId: "staff-cn-lead", decision: "candidate" });
  app.reviewByDoctor({ patientId: p2.id, reviewerId: "staff-cn-lead", decision: "candidate" });

  const s1 = findSlot(app, { roomId: "or-cwm-1", date: "2026-09-26", index: 0 });
  const s2 = findSlot(app, { roomId: "or-cwm-2", date: "2026-09-26", index: 0 });
  app.lockSlot({ slotId: s1.id, patientId: p1.id, staffIds: ["staff-cn-surgeon"], equipmentIds: [PHACO] });

  // 同一主刀、同一时段、另一手术室：人员冲突。
  assert.throws(
    () => app.lockSlot({ slotId: s2.id, patientId: p2.id, staffIds: ["staff-cn-surgeon"] }),
    expectError("STAFF_CONFLICT"),
  );
  // 同一设备、同一时段：设备冲突。
  assert.throws(
    () => app.lockSlot({ slotId: s2.id, patientId: p2.id, equipmentIds: [PHACO] }),
    expectError("EQUIPMENT_CONFLICT"),
  );
  // 耗材超量。
  assert.throws(
    () => app.lockSlot({ slotId: s2.id, patientId: p2.id, consumables: { "cons-iol-21": 999 } }),
    expectError("CONSUMABLE_SHORTAGE"),
  );
  // 无冲突组合可锁定。
  app.lockSlot({ slotId: s2.id, patientId: p2.id, staffIds: ["staff-fj-doctor"], equipmentIds: ["device-microscope-01"], consumables: { "cons-iol-21": 1 } });
  assert.equal(app.consumables.get("cons-iol-21").reserved, 1);
});

test("绿色通道必须记录理由；加塞先安置已排程者，关键阶段不可挤占", async () => {
  const { app } = await fresh();
  const a = app.registerPatient({ missionId: MISSION, alias: "A", proofType: "community_roster", proofRef: "CR-A", verifiedBy: "staff-fj-nurse" }).patient;
  const b = app.registerPatient({ missionId: MISSION, alias: "B", proofType: "community_roster", proofRef: "CR-B", verifiedBy: "staff-fj-nurse" }).patient;
  const c = app.registerPatient({ missionId: MISSION, alias: "C", proofType: "community_roster", proofRef: "CR-C", verifiedBy: "staff-fj-nurse" }).patient;
  for (const p of [a, b, c]) app.reviewByDoctor({ patientId: p.id, reviewerId: "staff-cn-lead", decision: "candidate" });

  const prime = findSlot(app, { roomId: "or-cwm-1", date: "2026-09-27", index: 0 });
  const { booking: bookingA } = app.lockSlot({ slotId: prime.id, patientId: a.id, staffIds: ["staff-cn-surgeon"] });

  assert.throws(
    () => app.lockSlot({ slotId: prime.id, patientId: b.id, greenChannel: { requestedBy: "staff-cn-lead" } }),
    expectError("GREEN_REASON_REQUIRED"),
  );

  // 临时加急：B 走绿色通道进入黄金时段，A 被安置到其他空闲时段而非丢失。
  const rush = app.lockSlot({
    slotId: prime.id,
    patientId: b.id,
    staffIds: ["staff-fj-doctor"],
    greenChannel: { reason: "高眼压濒临急性发作", requestedBy: "staff-cn-lead" },
  });
  assert.equal(rush.booking.greenChannel.reason, "高眼压濒临急性发作");
  assert.ok(rush.displacedTo, "被挤出的已排程患者必须有去向");
  assert.equal(slotOfBooking(app, bookingA.id).id, rush.displacedTo);

  // A 进入术前准备（关键阶段）后，任何加塞都被拒绝。
  app.advanceStage(bookingA.id, "prepped");
  const aSlot = slotOfBooking(app, bookingA.id);
  assert.throws(
    () => app.lockSlot({
      slotId: aSlot.id,
      patientId: c.id,
      staffIds: ["staff-fj-doctor"],
      greenChannel: { reason: "另一例加急", requestedBy: "staff-cn-lead" },
    }),
    expectError("CRITICAL_PROTECTED"),
  );
  assert.equal(slotOfBooking(app, bookingA.id).booking.patientId, a.id, "关键阶段患者保持原位");
});

test("知情同意保存语言版本与见证人；翻译变更留痕不覆盖", async () => {
  const { app } = await fresh();
  const p = app.registerPatient({ missionId: MISSION, alias: "Con", proofType: "community_roster", proofRef: "CR-Con", verifiedBy: "staff-fj-nurse" }).patient;

  assert.throws(
    () => app.recordConsent({ patientId: p.id, languageVersion: "itaukei-v1", witnessId: "staff-cn-nurse", textHash: "h1" }),
    expectError("WITNESS_QUALIFIED_ONLY"),
  );

  const r1 = app.recordConsent({ patientId: p.id, languageVersion: "itaukei-v1", translatedFrom: "zh-cn-v3", witnessId: "staff-fj-translator", textHash: "h1" });
  assert.equal(r1.duplicated, false);
  // 同一版本重复签署保持一条。
  assert.equal(app.recordConsent({ patientId: p.id, languageVersion: "itaukei-v1", translatedFrom: "zh-cn-v3", witnessId: "staff-fj-translator", textHash: "h1" }).duplicated, true);
  // 翻译修订产生新版本，旧版本不被覆盖。
  app.recordConsent({ patientId: p.id, languageVersion: "itaukei-v2", translatedFrom: "zh-cn-v3", witnessId: "staff-fj-translator", textHash: "h2" });
  const versions = [...app.consents.values()].filter((c) => c.patientId === p.id).map((c) => c.languageVersion).sort();
  assert.deepEqual(versions, ["itaukei-v1", "itaukei-v2"]);
});

test("重复同步/重复提交只产生一例治疗；无同意不得开台", async () => {
  const { app } = await fresh();
  const p = app.registerPatient({ missionId: MISSION, alias: "Op", proofType: "community_roster", proofRef: "CR-Op", verifiedBy: "staff-fj-nurse" }).patient;
  app.reviewByDoctor({ patientId: p.id, reviewerId: "staff-cn-lead", decision: "candidate" });
  const slot = findSlot(app, { roomId: "or-cwm-1", date: "2026-09-28", index: 1 });
  const { booking } = app.lockSlot({ slotId: slot.id, patientId: p.id, staffIds: ["staff-cn-surgeon"], consumables: { "cons-iol-21": 1 } });

  assert.throws(
    () => app.startTreatment({ bookingId: booking.id, procedure: "PHACO+IOL", clientRecordId: "offline-7", startedBy: "staff-cn-surgeon" }),
    expectError("CONSENT_MISSING"),
  );

  app.recordConsent({ patientId: p.id, languageVersion: "itaukei-v1", witnessId: "staff-fj-translator", textHash: "h" });
  const t1 = app.startTreatment({ bookingId: booking.id, procedure: "PHACO+IOL", clientRecordId: "offline-7", startedBy: "staff-cn-surgeon" });
  const t2 = app.startTreatment({ bookingId: booking.id, procedure: "PHACO+IOL", clientRecordId: "offline-7", startedBy: "staff-cn-surgeon" });
  const t3 = app.startTreatment({ bookingId: booking.id, procedure: "PHACO+IOL", startedBy: "staff-cn-surgeon" });
  assert.equal(t1.duplicated, false);
  assert.equal(t2.duplicated, true);
  assert.equal(t3.duplicated, true);
  assert.equal(t1.treatment.id, t2.treatment.id);
  assert.equal([...app.treatments.values()].filter((t) => t.patientId === p.id).length, 1);

  app.completeTreatment(t1.treatment.id);
  assert.equal(app.consumables.get("cons-iol-21").used, 1);
  assert.equal(app.consumables.get("cons-iol-21").reserved, 0);
});

test("患者退出：释放资源并生成有本地责任人的转介", async () => {
  const { app } = await fresh();
  const p = app.registerPatient({ missionId: MISSION, alias: "W", proofType: "community_roster", proofRef: "CR-W", verifiedBy: "staff-fj-nurse" }).patient;
  app.reviewByDoctor({ patientId: p.id, reviewerId: "staff-cn-lead", decision: "candidate" });
  const slot = findSlot(app, { roomId: "or-cwm-1", date: "2026-09-28", index: 2 });
  app.lockSlot({ slotId: slot.id, patientId: p.id, staffIds: ["staff-cn-surgeon"] });

  // 责任人不能是中方成员，必须来自本地承接医院。
  assert.throws(
    () => app.patientWithdraw({ patientId: p.id, reason: "家属决定返乡", responsiblePersonId: "staff-cn-nurse", followUpPlan: "x" }),
    expectError("RESPONSIBLE_LOCAL_ONLY"),
  );

  const result = app.patientWithdraw({
    patientId: p.id,
    reason: "家属决定返乡照顾",
    responsiblePersonId: "staff-fj-coordinator",
    followUpPlan: "一周内转瑙索里诊所复查，协调员跟踪到院",
  });
  assert.equal(result.referral.reason, "patient_withdrawal");
  assert.equal(result.referral.responsiblePersonId, "staff-fj-coordinator");
  assert.equal(slot.booking, null, "退出后时段与资源锁释放");

  // 同一主刀可立刻重新排入该时段，证明锁已释放。
  const q = app.registerPatient({ missionId: MISSION, alias: "Q", proofType: "community_roster", proofRef: "CR-Q", verifiedBy: "staff-fj-nurse" }).patient;
  app.reviewByDoctor({ patientId: q.id, reviewerId: "staff-cn-lead", decision: "candidate" });
  app.lockSlot({ slotId: slot.id, patientId: q.id, staffIds: ["staff-cn-surgeon"] });

  // 重复退出不制造第二条转介。
  assert.equal(app.patientWithdraw({ patientId: p.id, responsiblePersonId: "staff-fj-coordinator", followUpPlan: "x" }).duplicated, true);
});

test("设备故障：未进关键阶段的患者自动转介并指定责任人", async () => {
  const { app } = await fresh();
  const p = app.registerPatient({ missionId: MISSION, alias: "F", proofType: "community_roster", proofRef: "CR-F", verifiedBy: "staff-fj-nurse" }).patient;
  app.reviewByDoctor({ patientId: p.id, reviewerId: "staff-cn-lead", decision: "candidate" });
  const slot = findSlot(app, { roomId: "or-cwm-1", date: "2026-09-29", index: 0 });
  app.lockSlot({ slotId: slot.id, patientId: p.id, staffIds: ["staff-cn-surgeon"], equipmentIds: [PHACO] });

  const report = app.reportEquipmentFailure({
    deviceId: PHACO,
    slotId: slot.id,
    responsiblePersonId: "staff-fj-doctor",
    followUpPlan: "设备修复后优先补排，本地医生一周内联系",
  });
  assert.deepEqual(report.affected, [{ patientId: p.id, kept: false, referred: true }]);
  assert.ok([...app.referrals.values()].some((r) => r.patientId === p.id && r.reason === "equipment_failure"));

  // 故障设备不得再被锁定。
  assert.throws(
    () => app.lockSlot({ slotId: slot.id, patientId: p.id, equipmentIds: [PHACO] }),
    expectError("EQUIPMENT_FAILED"),
  );
});

test("访问控制：中方成员仅限本任务范围；本地医院授权交接后续看", async () => {
  const { app } = await fresh();
  const p = app.registerPatient({ missionId: MISSION, alias: "V", proofType: "community_roster", proofRef: "CR-V", verifiedBy: "staff-fj-nurse" }).patient;

  // 任务名册内的中方成员可看。
  assert.equal(app.canViewPatient("staff-cn-lead", p.id), true);
  // 未参与、且尚未授权交接的本地医院成员不可看。
  assert.equal(app.canViewPatient("staff-fj-coordinator", p.id), false);

  // 跨任务：仅属于斐济任务名册的中方护士不能访问第二个任务的患者。
  app.loadSeed({ project: "扩样", records: [{ id: "mission-samoa-2026", kind: "mission", local_hospital_id: "org-cwm-hospital", screening_capacity: 10, treatment_capacity: 5 }] });
  const other = app.registerPatient({ missionId: "mission-samoa-2026", alias: "Sasa", proofType: "passport", proofRef: "P-1", verifiedBy: "staff-fj-doctor" }).patient;
  assert.throws(() => app.assertViewPatient("staff-cn-nurse", other.id), expectError("OUT_OF_SCOPE"));

  // 授权交接：本地医院获得续看权限。
  app.authorizeHandover({ missionId: MISSION, toOrgId: "org-cwm-hospital", authorizedBy: "staff-cn-lead" });
  assert.equal(app.canViewPatient("staff-fj-coordinator", p.id), true);
});

test("任务收尾：无责任人不得关闭；关闭后中方访问冻结，全链可从别名还原", async () => {
  const { app } = await fresh();

  // 患者 1：完整治疗（离线筛查批次直接带入可核验别名）。
  app.syncScreeningBatch({ missionId: MISSION, deviceId: DEVICE, batchClientId: "b-done", rows: [batchRow({ rowId: "rd", alias: "Done", hash: "h-done" })] });
  const done = app.resolveByAlias(MISSION, "Done");
  const doneFindingIds = [...app.findings.keys()];
  app.reviewByDoctor({ patientId: done.id, reviewerId: "staff-cn-lead", decision: "candidate", findingIds: doneFindingIds });
  const slotDone = findSlot(app, { roomId: "or-cwm-1", date: "2026-09-29", index: 1 });
  app.lockSlot({ slotId: slotDone.id, patientId: done.id, staffIds: ["staff-cn-surgeon"] });
  app.recordConsent({ patientId: done.id, languageVersion: "itaukei-v1", witnessId: "staff-fj-translator", textHash: "hcd" });
  const t = app.startTreatment({ bookingId: slotDone.booking.id, procedure: "PHACO+IOL", clientRecordId: "row-done", startedBy: "staff-cn-surgeon" }).treatment;
  app.completeTreatment(t.id);

  // 患者 2：筛查后尚待决定（模拟未完成治疗）。
  app.syncScreeningBatch({ missionId: MISSION, deviceId: DEVICE2, batchClientId: "b-pending", rows: [batchRow({ rowId: "rp", alias: "Pending", hash: "h-pending", assist: "需进一步检查" })] });
  const pending = app.resolveByAlias(MISSION, "Pending");

  // 患者 3：设备故障已转介。
  const fail = app.registerPatient({ missionId: MISSION, alias: "Fail", proofType: "community_roster", proofRef: "CR-Fail", verifiedBy: "staff-fj-nurse" }).patient;
  app.reviewByDoctor({ patientId: fail.id, reviewerId: "staff-cn-lead", decision: "candidate" });
  const slotFail = findSlot(app, { roomId: "or-cwm-2", date: "2026-09-29", index: 0 });
  app.lockSlot({ slotId: slotFail.id, patientId: fail.id, staffIds: ["staff-fj-doctor"], equipmentIds: [PHACO] });
  app.reportEquipmentFailure({ deviceId: PHACO, responsiblePersonId: "staff-fj-doctor", followUpPlan: "下周补排" });

  // 未授权交接不得关闭。
  assert.throws(() => app.closeMission({ missionId: MISSION }), expectError("HANDOVER_REQUIRED"));
  app.authorizeHandover({ missionId: MISSION, toOrgId: "org-cwm-hospital", authorizedBy: "staff-cn-lead" });

  // Pending 没有责任人且未给收尾方案：拒绝关闭。
  assert.throws(() => app.closeMission({ missionId: MISSION, plans: {} }), expectError("RESPONSIBLE_REQUIRED"));

  const closed = app.closeMission({
    missionId: MISSION,
    plans: { default: { responsiblePersonId: "staff-fj-coordinator", followUpPlan: "纳入 CWM 医院眼科随访队列，一周内复诊" } },
  });
  assert.equal(closed.closed, true);
  assert.equal(closed.unfinished, 2);

  // 关闭后中方成员访问冻结；本地责任人仍可查看。
  assert.throws(() => app.assertViewPatient("staff-cn-lead", pending.id), expectError("MISSION_CLOSED"));
  assert.equal(app.canViewPatient("staff-fj-coordinator", pending.id), true);

  // 连续性审计：没有无人承接的记录。
  const audit = continuityAudit(app, MISSION);
  assert.equal(audit.total, 3);
  assert.equal(audit.orphans.length, 0);

  // 从当地别名还原：筛查 → 人工决定 → 治疗/转介 → 后续负责人。
  const chainDone = restoreByAlias(app, MISSION, "Done");
  assert.equal(chainDone.chain.screened, true);
  assert.equal(chainDone.chain.humanDecision, true);
  assert.equal(chainDone.chain.endpoint.kind, "treatment_completed");

  const chainPending = restoreByAlias(app, MISSION, "Pending");
  assert.equal(chainPending.chain.endpoint.kind, "referral");
  assert.equal(chainPending.chain.endpoint.reason, "mission_close");
  assert.equal(chainPending.chain.endpoint.responsiblePersonId, "staff-fj-coordinator");

  const chainFail = restoreByAlias(app, MISSION, "Fail");
  assert.equal(chainFail.chain.endpoint.reason, "equipment_failure");
  assert.equal(chainFail.chain.hasResponsiblePerson, true);

  const types = chainDone.events.map((e) => e.type);
  assert.ok(types.includes("offline_finding") && types.includes("doctor_decision") && types.includes("treatment"));
});
