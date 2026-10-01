import assert from "node:assert/strict";
import test from "node:test";

import { makeBackend, M, ids, admitCandidate, throwsCode } from "./helpers.js";

const T1 = "2026-09-29T08:00:00.000Z";
const T2 = "2026-09-29T09:00:00.000Z";
const T3 = "2026-09-29T10:00:00.000Z";

const or1Resources = [ids.or1, ids.phaco1, ids.scope1];
const or2Resources = [ids.or2, ids.phaco2, ids.scope2];
const oneIol = { [ids.iol]: 1, [ids.visc]: 1, [ids.pack]: 1 };

test("手术间/设备/人员/耗材按时段锁定，重叠时段报资源冲突", async () => {
  const { backend } = await makeBackend();
  const p1 = admitCandidate(backend, { localName: "PatientA" });
  const p2 = admitCandidate(backend, { localName: "PatientB" });

  backend.scheduleSlot({
    missionId: M, patientId: p1, memberId: ids.wang,
    startAt: T1, endAt: T2, resourceIds: or1Resources,
    staffIds: [ids.chen, ids.lin], consumables: oneIol,
  });

  // 同一手术间+同一主刀，重叠时段必须拒绝
  let err = null;
  try {
    backend.scheduleSlot({
      missionId: M, patientId: p2, memberId: ids.wang,
      startAt: T1, endAt: T2, resourceIds: or1Resources,
      staffIds: [ids.chen], consumables: oneIol,
    });
  } catch (e) {
    err = e;
  }
  assert.ok(err, "重叠锁定应被拒绝");
  assert.equal(err.code, "RESOURCE_CONFLICT");
  assert.equal(err.details.resourceId, ids.or1);
  assert.equal(err.details.patientId, p1, "冲突应指出已锁定方");

  // 相邻不重叠时段可以锁定同一资源
  const slot2 = backend.scheduleSlot({
    missionId: M, patientId: p2, memberId: ids.wang,
    startAt: T2, endAt: T3, resourceIds: or1Resources,
    staffIds: [ids.chen, ids.lin], consumables: oneIol,
  });
  assert.equal(slot2.status, "held");

  // 耗材预占随锁定生效
  const avail = backend.consumableAvailability(ids.iol);
  assert.equal(avail.available, 28, "30 库存 - 2 预占");
});

test("耗材超量锁定被拒绝，已完成治疗才扣减库存", async () => {
  const { backend } = await makeBackend();
  const p1 = admitCandidate(backend, { localName: "StockA" });
  backend.scheduleSlot({
    missionId: M, patientId: p1, memberId: ids.wang,
    startAt: T1, endAt: T2, resourceIds: or1Resources, staffIds: [ids.chen],
    consumables: { [ids.iol]: 25 },
  });
  throwsCode(
    () =>
      backend.scheduleSlot({
        missionId: M, patientId: admitCandidate(backend, { localName: "StockB" }),
        memberId: ids.wang, startAt: T2, endAt: T3, resourceIds: or2Resources,
        staffIds: [ids.singh], consumables: { [ids.iol]: 10 },
      }),
    "CONSUMABLE_SHORTAGE",
  );

  backend.advancePhase({ missionId: M, slotId: backend.state.patients[p1].slot_ids[0], memberId: ids.chen, phase: "in_surgery" });
  backend.completeTreatment({
    missionId: M, patientId: p1, memberId: ids.chen,
    procedure: "phacoemulsification+IOL", clientTxId: "tx-stockA",
  });
  const avail = backend.consumableAvailability(ids.iol);
  assert.equal(avail.used, 25);
  assert.equal(avail.held, 0, "完成后预占应转为已用");
});

test("绿色通道加急必须记录理由，且不能挤占已进入关键阶段的患者", async () => {
  const { backend } = await makeBackend();

  // 普通患者先锁定一号手术间 08:00-10:00 并进入术前准备（关键阶段）
  const normal = admitCandidate(backend, { localName: "NormalCase" });
  backend.scheduleSlot({
    missionId: M, patientId: normal, memberId: ids.wang,
    startAt: T1, endAt: T3, resourceIds: or1Resources,
    staffIds: [ids.chen, ids.lin], consumables: oneIol,
  });
  backend.advancePhase({
    missionId: M, slotId: backend.state.patients[normal].slot_ids[0],
    memberId: ids.chen, phase: "preop",
  });

  // 加急患者走绿色复核（理由已记录）
  const urgent = admitCandidate(backend, {
    decision: "green_channel",
    reason: "右眼急性视力丧失，需当日处理",
    localName: "UrgentCase",
  });

  // 无理由加急被拒
  throwsCode(
    () =>
      backend.expediteSlot({
        missionId: M, patientId: urgent, coordinatorId: ids.wang,
        startAt: T1, endAt: T2, resourceIds: or2Resources, staffIds: [ids.singh],
        consumables: oneIol, reason: "   ",
      }),
    "VALIDATION",
  );

  // 试图抢占已进入术前阶段患者的资源 → 拒绝而不是踢人
  let blocked = null;
  try {
    backend.expediteSlot({
      missionId: M, patientId: urgent, coordinatorId: ids.wang,
      startAt: T1, endAt: T2, resourceIds: or1Resources, // 撞上普通患者
      staffIds: [ids.chen], consumables: oneIol,
      reason: "急性视力丧失",
    });
  } catch (e) {
    blocked = e;
  }
  assert.ok(blocked);
  assert.equal(blocked.code, "PROTECTED_PATIENT");
  assert.equal(blocked.details.blockingPatientId, normal);
  assert.equal(blocked.details.phase, "preop");
  assert.equal(backend.state.patients[normal].status, "preop", "被保护患者排程不得被改动");

  // 改到二号手术间不冲突 → 加急成功，理由双留痕
  const fast = backend.expediteSlot({
    missionId: M, patientId: urgent, coordinatorId: ids.wang,
    startAt: T1, endAt: T2, resourceIds: or2Resources,
    staffIds: [ids.singh, ids.ana], consumables: oneIol,
    reason: "急性视力丧失",
  });
  assert.equal(fast.priority, "green_channel");
  assert.equal(fast.expedite.reason, "急性视力丧失");
  assert.equal(fast.expedite.review_reason, "右眼急性视力丧失，需当日处理");
});

test("非绿色通道患者不能走加急", async () => {
  const { backend } = await makeBackend();
  const p = admitCandidate(backend, { localName: "PlainCase" });
  throwsCode(
    () =>
      backend.expediteSlot({
        missionId: M, patientId: p, coordinatorId: ids.wang,
        startAt: T1, endAt: T2, resourceIds: or2Resources, staffIds: [ids.singh],
        reason: "医生口头要求",
      }),
    "NOT_GREEN_CHANNEL",
  );
});

test("排程前置闸门：未复核/未同意不能锁定资源", async () => {
  const { backend } = await makeBackend();

  const reg = backend.registerScreening({
    missionId: M, batchId: "b", localName: "Raw", village: "V",
    verifierId: ids.jonasa, registeredBy: ids.ana,
  });
  throwsCode(
    () =>
      backend.scheduleSlot({
        missionId: M, patientId: reg.patientId, memberId: ids.wang,
        startAt: T1, endAt: T2, resourceIds: or1Resources,
      }),
    "NOT_REVIEWED",
  );
});
