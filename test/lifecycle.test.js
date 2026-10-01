import assert from "node:assert/strict";
import test from "node:test";

import { makeBackend, M, ids, admitCandidate, throwsCode } from "./helpers.js";

const T1 = "2026-09-29T08:00:00.000Z";
const T2 = "2026-09-29T09:00:00.000Z";
const T3 = "2026-09-29T10:00:00.000Z";
const resources = [ids.or1, ids.phaco1, ids.scope1];
const oneIol = { [ids.iol]: 1 };

function admitAndSchedule(backend, name, { resources: r = resources, staff = [ids.chen], startAt = T1, endAt = T2 } = {}) {
  const pid = admitCandidate(backend, { localName: name });
  backend.scheduleSlot({
    missionId: M, patientId: pid, memberId: ids.wang,
    startAt, endAt, resourceIds: r, staffIds: staff, consumables: oneIol,
  });
  return pid;
}

test("重复同步治疗不得创建第二例治疗，耗材不重复扣减", async () => {
  const { backend } = await makeBackend();
  const pid = admitAndSchedule(backend, "TxCase");

  const tx1 = backend.completeTreatment({
    missionId: M, patientId: pid, memberId: ids.chen,
    procedure: "phacoemulsification+IOL", clientTxId: "dev-tx-001",
  });
  assert.equal(tx1.duplicate, false);

  // 弱网重发：相同 clientTxId
  const tx2 = backend.completeTreatment({
    missionId: M, patientId: pid, memberId: ids.chen,
    procedure: "phacoemulsification+IOL", clientTxId: "dev-tx-001",
  });
  assert.equal(tx2.duplicate, true);
  assert.equal(tx2.id, tx1.id);

  // 另一端换了事务号重放，仍不得产生第二例
  const tx3 = backend.completeTreatment({
    missionId: M, patientId: pid, memberId: ids.chen,
    procedure: "phacoemulsification+IOL", clientTxId: "dev-tx-001-retry-from-tablet",
  });
  assert.equal(tx3.id, tx1.id);

  assert.equal(Object.keys(backend.state.treatments).length, 1);
  assert.equal(backend.consumableAvailability(ids.iol).used, 1);
  assert.equal(backend.state.patients[pid].status, "treated");
});

test("患者退出必须生成明确转介与责任人，并释放已锁定资源", async () => {
  const { backend } = await makeBackend();
  const quitter = admitAndSchedule(backend, "Quitter");
  const other = admitCandidate(backend, { localName: "OtherPatient" });

  // 无责任人或无理由都不允许
  throwsCode(
    () => backend.createReferral({
      missionId: M, patientId: quitter, memberId: ids.wang,
      outcome: "withdrawn", reason: "家属要求回家",
    }),
    "VALIDATION",
  );

  const referral = backend.createReferral({
    missionId: M, patientId: quitter, memberId: ids.wang,
    outcome: "withdrawn", reason: "术后家属临时改变主意，需回本地医院评估另一眼",
    destinationHospitalId: ids.hospital,
    followUpOwnerId: ids.singh, followUpDueAt: "2026-10-07T00:00:00.000Z",
  });
  assert.equal(referral.destination_hospital_id, ids.hospital);
  assert.equal(referral.follow_up_owner_id, ids.singh);

  // 原有时段与耗材预占被释放，其他患者可以顶上
  const replacement = backend.scheduleSlot({
    missionId: M, patientId: other, memberId: ids.wang,
    startAt: T1, endAt: T2, resourceIds: resources, staffIds: [ids.chen], consumables: oneIol,
  });
  assert.equal(replacement.status, "held");
  assert.equal(backend.state.slots[referral.released_slot_ids[0]].status, "released");

  // 不能重复转介
  throwsCode(
    () => backend.createReferral({
      missionId: M, patientId: quitter, memberId: ids.wang,
      outcome: "withdrawn", reason: "再次退出", followUpOwnerId: ids.singh,
    }),
    "ALREADY_REFERRED",
  );
});

test("设备故障登记后，受影响未治疗患者自动获得带责任人的转介，资源释放", async () => {
  const { backend } = await makeBackend();
  const p1 = admitAndSchedule(backend, "FaultA", { startAt: T1, endAt: T2 });
  const p2 = admitAndSchedule(backend, "FaultB", { startAt: T2, endAt: T3 });

  const { event, referrals } = backend.reportEquipmentFailure({
    missionId: M, equipmentId: ids.phaco1, memberId: ids.wang,
    reason: "乳化手柄异响后无负压输出，现场无法修复",
    affectedPatientIds: [p1, p2],
    followUpOwnerId: ids.singh, followUpDueAt: "2026-10-05T00:00:00.000Z",
  });
  assert.equal(event.equipment_id, ids.phaco1);
  assert.equal(referrals.length, 2);
  for (const r of referrals) {
    assert.equal(r.outcome, "equipment_failure");
    assert.equal(r.follow_up_owner_id, ids.singh);
    assert.match(r.reason, /eq-phaco-01/);
  }
  assert.deepEqual(
    Object.values(backend.state.slots).filter((s) => s.status === "held").map((s) => s.id),
    [],
    "占用故障设备的未完成时段应全部释放",
  );
  assert.equal(backend.consumableAvailability(ids.iol).available, 30, "预占耗材全部退回");

  // 责任人确认承接
  const ack = backend.acknowledgeReferral({ missionId: M, referralId: referrals[0].id, memberId: ids.singh });
  assert.equal(ack.status, "acknowledged");
  assert.equal(backend.state.patients[referrals[0].patient_id].status, "followup_accepted");

  // 转介记录必须携带被释放的时段
  assert.ok(referrals[0].released_slot_ids.length >= 1);
});

test("设备故障波及未治疗患者但未指定责任人时拒绝登记", async () => {
  const { backend } = await makeBackend();
  const pid = admitAndSchedule(backend, "FaultNoOwner");
  throwsCode(
    () => backend.reportEquipmentFailure({
      missionId: M, equipmentId: ids.phaco1, memberId: ids.wang,
      reason: "设备故障", affectedPatientIds: [pid],
    }),
    "VALIDATION",
  );
});

test("任务结束：先交接授权；未闭环患者存在时拒绝关闭，全部有归属后关闭", async () => {
  const { backend } = await makeBackend();

  const treated = admitAndSchedule(backend, "Done");
  backend.completeTreatment({ missionId: M, patientId: treated, memberId: ids.chen, procedure: "phaco+IOL", clientTxId: "t1" });

  const unfinished = admitCandidate(backend, { localName: "LeftBehind" });
  // 排程后未治疗
  backend.scheduleSlot({
    missionId: M, patientId: unfinished, memberId: ids.wang,
    startAt: T1, endAt: T2, resourceIds: [ids.or2, ids.phaco2, ids.scope2],
    staffIds: [ids.singh], consumables: oneIol,
  });

  // 未授权交接不能关闭
  throwsCode(
    () => backend.closeMission({ missionId: M, memberId: ids.wang }),
    "HANDOVER_REQUIRED",
  );

  backend.authorizeHandover({ missionId: M, hospitalId: ids.hospital, memberId: ids.wang });

  // 有未治疗且无转介的患者 → 拒绝关闭并列出孤儿
  let blocked = null;
  try {
    backend.closeMission({ missionId: M, memberId: ids.wang });
  } catch (e) {
    blocked = e;
  }
  assert.equal(blocked.code, "ORPHANED_PATIENTS");
  assert.deepEqual(blocked.details.orphaned.map((o) => o.patientId), [unfinished]);

  // 以“任务结束”结局转介给本地责任人
  const ref = backend.createReferral({
    missionId: M, patientId: unfinished, memberId: ids.wang,
    outcome: "mission_end", reason: "行动返程在即，晶体测量需复查，转本地医院排期手术",
    followUpOwnerId: ids.singh, followUpDueAt: "2026-10-14T00:00:00.000Z",
  });
  assert.equal(ref.outcome, "mission_end");

  const mission = backend.closeMission({ missionId: M, memberId: ids.wang });
  assert.equal(mission.status, "closed");
  assert.equal(mission.close_summary.total_patients, 2);
  assert.equal(mission.close_summary.treated, 1);
  assert.equal(mission.close_summary.referred, 1);
  assert.deepEqual(backend.findOrphans(M), []);
});

test("访问控制：中方成员仅限任务范围；本地医院获授权交接后才能继续查看", async () => {
  const { backend } = await makeBackend();
  const pid = admitAndSchedule(backend, "AccessCase");
  backend.completeTreatment({ missionId: M, patientId: pid, memberId: ids.chen, procedure: "phaco+IOL", clientTxId: "t" });

  // 其他任务的中方成员：读写皆拒
  throwsCode(() => backend.timeline(pid, ids.other), "OUT_OF_MISSION_SCOPE");

  // 未获授权交接的外院医生：不能读
  throwsCode(() => backend.timeline(pid, ids.ram), "NO_HANDOVER");

  // 本任务本地成员在任务进行中可读
  assert.doesNotThrow(() => backend.timeline(pid, ids.singh));

  // 仅向 CWM 医院交接并关闭任务
  backend.authorizeHandover({ missionId: M, hospitalId: ids.hospital, memberId: ids.wang });
  backend.closeMission({ missionId: M, memberId: ids.wang });

  // 关闭后：中方成员仍可读（任务范围内），但不能写
  assert.doesNotThrow(() => backend.timeline(pid, ids.chen));
  throwsCode(
    () => backend.registerScreening({
      missionId: M, batchId: "late", localName: "Late",
      verifierId: ids.jonasa, registeredBy: ids.chen,
    }),
    "MISSION_CLOSED",
  );

  // 获授权的 CWM 本地成员返程后可继续查看
  assert.doesNotThrow(() => backend.timeline(pid, ids.jonasa));
  // 未获交接授权的楠迪医院在任务结束后仍然不可见
  throwsCode(() => backend.timeline(pid, ids.ram), "NO_HANDOVER");
});

test("从患者别名可还原筛查、人工决定、治疗/转介及后续负责人", async () => {
  const { backend } = await makeBackend();

  // 治疗链路
  const doneName = "Josefa Done";
  const done = admitCandidate(backend, { localName: doneName, village: "Nausori" });
  backend.scheduleSlot({
    missionId: M, patientId: done, memberId: ids.wang,
    startAt: T1, endAt: T2, resourceIds: resources, staffIds: [ids.chen], consumables: oneIol,
  });
  backend.completeTreatment({ missionId: M, patientId: done, memberId: ids.chen, procedure: "phaco+IOL", clientTxId: "tx-done" });

  // 转介链路
  const refName = "Asena Ref";
  const referred = admitCandidate(backend, { localName: refName, village: "Lami" });
  backend.scheduleSlot({
    missionId: M, patientId: referred, memberId: ids.wang,
    startAt: T1, endAt: T2, resourceIds: [ids.or2, ids.phaco2, ids.scope2],
    staffIds: [ids.singh], consumables: oneIol,
  });
  backend.createReferral({
    missionId: M, patientId: referred, memberId: ids.wang,
    outcome: "mission_end", reason: "需眼底检查后再定手术",
    followUpOwnerId: ids.singh, followUpDueAt: "2026-10-14T00:00:00.000Z",
  });

  const [doneView] = backend.resolveByAlias({
    missionId: M, localName: `  ${doneName.toUpperCase()}  `, village: "NAUSORI", actorId: ids.chen,
  });
  const stages = doneView.trail.map((t) => t.stage);
  assert.deepEqual(stages, ["screening", "image_synced", "physician_decision", "consent", "scheduling", "treatment"]);
  assert.equal(doneView.outcome.kind, "treated");
  assert.equal(doneView.outcome.performed_by, ids.chen);

  const [refView] = backend.resolveByAlias({
    missionId: M, localName: refName, village: "Lami", actorId: ids.jonasa,
  });
  assert.equal(refView.outcome.kind, "mission_end");
  assert.equal(refView.outcome.follow_up_owner.id, ids.singh);
  assert.equal(refView.outcome.follow_up_owner.name, "苏尼尔·辛格");
  assert.ok(refView.outcome.follow_up_due_at);
});
