#!/usr/bin/env node
/**
 * 斐济光明行 · 返程倒计时协同场景演示
 * 运行：node scripts/demo.mjs
 *
 * 串联：别名入批 → 离线图像去重合并 → 医生复核 → 同意(语言版本/见证人)
 *      → 资源时段锁定 → 绿色加急(关键阶段保护) → 治疗幂等
 *      → 退出/设备故障/任务结束转介责任人 → 交接授权 → 关闭 → 返程后别名还原
 */
import { loadSeed } from "../src/seed.js";
import { MissionBackend } from "../src/backend.js";
import { createStore } from "../src/store.js";

const step = (n, title) => console.log(`\n${n} ${title}` + "\n" + "─".repeat(62));
const ok = (msg) => console.log(`  ✓ ${msg}`);
const say = (msg) => console.log(`  · ${msg}`);

const M = "mission-fiji-2026";
const I = {
  or1: "room-or-1", or2: "room-or-2",
  phaco1: "eq-phaco-01", phaco2: "eq-phaco-02",
  scope1: "eq-microscope-01", scope2: "eq-microscope-02",
  iol: "cons-iol", visc: "cons-visc", pack: "cons-pack",
  dev3: "device-chongming-03", dev7: "device-chongming-07",
  hospital: "hospital-cwm",
  chen: "staff-chen", lin: "staff-lin", wang: "staff-wang",
  singh: "staff-singh", ana: "staff-ana", jonasa: "staff-jonasa",
};

const seed = await loadSeed("fixtures/seed.json");
const backend = new MissionBackend(seed, { store: createStore() });

// 1 ── 村落筛查：当地可核验别名入批
step(1, "村落筛查：以当地别名进入筛查批次（当地联络人当面核验）");
const reg1 = backend.registerScreening({
  missionId: M, batchId: "batch-nausori-0928", localName: "Josefa Bole",
  locale: "fj", village: "Nausori", verifierId: I.jonasa,
  registeredBy: I.ana, deviceId: I.dev3,
});
ok(`建档 ${reg1.patientId}（别名 Josefa Bole，核验人 乔内萨）`);

const regAgain = backend.registerScreening({
  missionId: M, batchId: "batch-nausori-0929", localName: "josefa bole",
  locale: "fj", village: "nausori", verifierId: I.jonasa,
  registeredBy: I.ana, deviceId: I.dev7,
});
ok(`次日另一台设备重复登记 → 复用同一档案（${regAgain.reused ? "未产生第二例" : "异常"}）`);

const reg2 = backend.registerScreening({
  missionId: M, batchId: "batch-nausori-0928", localName: "Asena Taga",
  locale: "fj", village: "Nausori", verifierId: I.jonasa,
  registeredBy: I.ana, deviceId: I.dev3,
});
const reg3 = backend.registerScreening({
  missionId: M, batchId: "batch-lami-0928", localName: "Wati Raile",
  locale: "fj", village: "Lami", verifierId: I.jonasa,
  registeredBy: I.ana, deviceId: I.dev3,
});
ok(`同日另两例建档：Asena Taga → ${reg2.patientId}；Wati Raile → ${reg3.patientId}`);

// 排在一号机后续时段的第四例（故障将波及他）
const reg4 = backend.registerScreening({
  missionId: M, batchId: "batch-nausori-0929", localName: "Semi Vula",
  locale: "fj", village: "Nausori", verifierId: I.jonasa,
  registeredBy: I.ana, deviceId: I.dev7,
});
backend.syncImageSummary({
  missionId: M, batchId: "batch-nausori-0929", deviceId: I.dev7, patientId: reg4.patientId,
  contentHash: "sha256:semi-eye-l", assistSuggestion: { condition: "cataract" },
  clientSyncId: "dev7-0011", actorId: I.ana,
});
backend.reviewPatient({ missionId: M, patientId: reg4.patientId, doctorId: I.chen, decision: "eligible", reason: "左眼白内障，符合手术指征" });
backend.recordConsent({
  missionId: M, patientId: reg4.patientId, memberId: I.lin,
  languageVersion: "fj-Latn-fiji-2026-v1", witnessId: I.jonasa, signatureType: "thumbprint",
});

// 2 ── 离线图像摘要联网同步：重传幂等 + 跨设备内容合并
step(2, "便携设备离线图像摘要联网同步（去重合并）");
const img = backend.syncImageSummary({
  missionId: M, batchId: "batch-nausori-0928", deviceId: I.dev3, patientId: reg1.patientId,
  contentHash: "sha256:josefa-eye-r", capturedAt: "2026-09-28T01:10:00Z",
  assistSuggestion: { condition: "cataract", confidence: 0.92 },
  clientSyncId: "dev3-offline-0001", actorId: I.ana,
});
ok(`图像入库 ${img.imageId}；辅助判断标记为 advisory_only，不改变患者状态`);
const replay = backend.syncImageSummary({
  missionId: M, batchId: "batch-nausori-0928", deviceId: I.dev3, patientId: reg1.patientId,
  contentHash: "sha256:josefa-eye-r", clientSyncId: "dev3-offline-0001", actorId: I.ana,
});
ok(`断网重传同一同步号 → ${replay.replayed ? "幂等返回首条，未重复入库" : "异常"}`);
const merged = backend.syncImageSummary({
  missionId: M, batchId: "batch-nausori-0929", deviceId: I.dev7, patientId: reg1.patientId,
  contentHash: "sha256:josefa-eye-r", clientSyncId: "dev7-offline-0007", actorId: I.ana,
});
ok(`07号箱同内容哈希重拍 → ${merged.merged ? "合并到同一图像，保留两个批次来源" : "异常"}`);

for (const [pid, hash, sync] of [
  [reg2.patientId, "sha256:asena-eye-r", "dev3-0002"],
  [reg3.patientId, "sha256:wati-eye-l", "dev3-0003"],
]) {
  backend.syncImageSummary({
    missionId: M, batchId: "batch-nausori-0928", deviceId: I.dev3, patientId: pid,
    contentHash: hash, assistSuggestion: { condition: "cataract" },
    clientSyncId: sync, actorId: I.ana,
  });
}

// 3 ── 医生复核是唯一闸门
step(3, "医生人工复核（辅助判断不能替代）");
backend.reviewPatient({ missionId: M, patientId: reg1.patientId, doctorId: I.chen, decision: "eligible", reason: "右眼成熟期白内障，符合手术指征" });
ok("Josefa：陈医生复核 eligible → 进入候选治疗路径");
backend.reviewPatient({
  missionId: M, patientId: reg2.patientId, doctorId: I.chen,
  decision: "green_channel", reason: "右眼急性视力降至手动，疑似过熟期合并高眼压，需当日处理",
});
ok("Asena：陈医生复核 green_channel，理由已记录");
backend.reviewPatient({ missionId: M, patientId: reg3.patientId, doctorId: I.singh, decision: "observe", reason: "轻度混浊，建议三月后复查" });
ok("Wati：辛格医生复核 observe → 不进入治疗路径");

// 4 ── 知情同意：语言版本 + 见证人
step(4, "知情同意（保存语言版本与见证人）");
const c1 = backend.recordConsent({
  missionId: M, patientId: reg1.patientId, memberId: I.lin,
  languageVersion: "fj-Latn-fiji-2026-v1", witnessId: I.jonasa, signatureType: "thumbprint",
});
ok(`Josefa：斐济语拉丁字版本 ${c1.language_version}，按指印 + 见证人乔内萨`);
backend.recordConsent({
  missionId: M, patientId: reg2.patientId, memberId: I.lin,
  languageVersion: "fj-Latn-fiji-2026-v1", witnessId: I.jonasa, signatureType: "thumbprint",
});
ok("Asena：同版本同意书与见证人齐备");

// 5 ── 资源时段锁定
step(5, "手术间 / 设备 / 人员 / 耗材按时段锁定");
const T = ["2026-09-30T00:00:00Z", "2026-09-30T01:00:00Z", "2026-09-30T02:00:00Z", "2026-09-30T03:00:00Z"];
const s1 = backend.scheduleSlot({
  missionId: M, patientId: reg1.patientId, memberId: I.wang,
  startAt: T[0], endAt: T[2], resourceIds: [I.or1, I.phaco1, I.scope1],
  staffIds: [I.chen, I.lin], consumables: { [I.iol]: 1, [I.visc]: 1, [I.pack]: 1 },
});
ok(`Josefa 锁定一号手术间 08:00-10:00（陈医生/林护士 + 人工晶体等耗材预占）`);
backend.advancePhase({ missionId: M, slotId: s1.id, memberId: I.chen, phase: "preop" });
ok("Josefa 已进入术前准备（关键阶段）");
let conflict;
try {
  backend.scheduleSlot({
    missionId: M, patientId: reg2.patientId, memberId: I.wang,
    startAt: T[0], endAt: T[1], resourceIds: [I.or1, I.phaco1, I.scope1],
    staffIds: [I.chen], consumables: { [I.iol]: 1 },
  });
} catch (e) { conflict = e; }
ok(`重叠锁定同一手术间/主刀被拒绝：${conflict?.code}`);

// 6 ── 绿色通道加急：不得挤占关键阶段患者
step(6, "临时加急（绿色通道：理由必填，不得挤占关键阶段患者）");
let blocked;
try {
  backend.expediteSlot({
    missionId: M, patientId: reg2.patientId, coordinatorId: I.wang,
    startAt: T[0], endAt: T[1], resourceIds: [I.or1, I.phaco1], staffIds: [I.chen],
    consumables: { [I.iol]: 1 }, reason: "急性视力丧失",
  });
} catch (e) { blocked = e; }
ok(`加急抢占一号手术间被拒：${blocked?.code}（被保护患者 ${blocked?.details.phase}），系统不踢人`);
const fast = backend.expediteSlot({
  missionId: M, patientId: reg2.patientId, coordinatorId: I.wang,
  startAt: T[0], endAt: T[1], resourceIds: [I.or2, I.phaco2, I.scope2],
  staffIds: [I.singh, I.ana], consumables: { [I.iol]: 1, [I.visc]: 1, [I.pack]: 1 },
  reason: "急性视力丧失，协调员改二号手术间",
});
ok(`Asena 加急成功，锁定二号手术间 08:00-09:00；加急理由与复核理由双留痕`);

// 7 ── 治疗完成 + 重复同步
step(7, "治疗记录（重复同步不得创建第二例治疗）");
const tx1 = backend.completeTreatment({
  missionId: M, patientId: reg1.patientId, memberId: I.chen,
  procedure: "右眼白内障超声乳化吸除+人工晶体植入", clientTxId: "tablet-tx-josefa-1",
});
const txRetry = backend.completeTreatment({
  missionId: M, patientId: reg1.patientId, memberId: I.chen,
  procedure: "右眼白内障超声乳化吸除+人工晶体植入", clientTxId: "tablet-tx-josefa-1",
});
const txOtherDevice = backend.completeTreatment({
  missionId: M, patientId: reg1.patientId, memberId: I.chen,
  procedure: "右眼白内障超声乳化吸除+人工晶体植入", clientTxId: "nurse-station-retry-9",
});
ok(`Josefa 治疗完成 ${tx1.id}`);
ok(`弱网重发 + 另一台工作站补发均返回同一记录：${txRetry.id === tx1.id && txOtherDevice.id === tx1.id ? "确认只有一例治疗" : "异常"}`);
ok(`人工晶体库存：已用 ${backend.consumableAvailability(I.iol).used} 片（未重复扣减）`);

// 加急患者术中设备故障
backend.advancePhase({ missionId: M, slotId: fast.id, memberId: I.singh, phase: "in_surgery" });

// Semi 排在一号机 10:00-11:00（故障波及对象）
const s4 = backend.scheduleSlot({
  missionId: M, patientId: reg4.patientId, memberId: I.wang,
  startAt: T[2], endAt: T[3], resourceIds: [I.or1, I.phaco1, I.scope1],
  staffIds: [I.chen, I.lin], consumables: { [I.iol]: 1, [I.visc]: 1, [I.pack]: 1 },
});
ok(`Semi 已排一号手术间 10:00-11:00（${s4.id}）`);

// 8 ── 患者退出
step(8, "患者退出：明确转介与责任人，释放资源");
const withdrawRef = backend.createReferral({
  missionId: M, patientId: reg2.patientId, memberId: I.wang,
  outcome: "withdrawn",
  reason: "患者术中自诉不适、家属要求暂停；需本地医院控制眼压并评估后再安排",
  destinationHospitalId: I.hospital, followUpOwnerId: I.singh,
  followUpDueAt: "2026-10-07T00:00:00Z",
});
ok(`Asena 退出转介：${withdrawRef.destination_hospital_id}，责任人 辛格医生，期限 2026-10-07`);
ok(`已锁定时段 ${withdrawRef.released_slot_ids.length} 个与耗材预占同步释放`);

// 9 ── 设备故障
step(9, "设备故障：受影响患者自动生成转介");
const { event, referrals } = backend.reportEquipmentFailure({
  missionId: M, equipmentId: I.phaco1, memberId: I.wang,
  reason: "乳化手柄异响后无负压输出，现场无法修复",
  affectedPatientIds: [], followUpOwnerId: I.singh,
  followUpDueAt: "2026-10-05T00:00:00Z",
});
ok(`故障登记 ${event.id}；自动转介 ${referrals.length} 例（Josefa 已治疗不再转介；Semi 等未治疗者自动转介）`);
if (referrals[0]) {
  const ack = backend.acknowledgeReferral({ missionId: M, referralId: referrals[0].id, memberId: I.singh });
  ok(`责任人辛格医生确认承接 ${referrals[0].patient_id}：${ack.status === "acknowledged" ? "已承接" : ack.status}`);
}

// 10 ── Wati（observe）也需在任务结束时有归属
const observeRef = backend.createReferral({
  missionId: M, patientId: reg3.patientId, memberId: I.wang,
  outcome: "mission_end",
  reason: "观察期患者，行动结束后需本地眼科三月复查后决定是否手术",
  destinationHospitalId: I.hospital, followUpOwnerId: I.jonasa,
  followUpDueAt: "2027-01-05T00:00:00Z",
  notes: "联络人负责召回，辛格医生出复查门诊",
});
ok(`Wati 以 mission_end 转介：责任人乔内萨负责召回（${observeRef.id}）`);

// 11 ── 交接授权与任务关闭
step(10, "交接授权与任务关闭（零孤儿校验）");
backend.authorizeHandover({ missionId: M, hospitalId: I.hospital, memberId: I.wang });
ok("已向苏瓦殖民战争纪念医院授权交接");
const orphansBefore = backend.findOrphans(M);
say(`关闭前孤儿扫描：未治疗 ${Object.values(backend.state.patients).filter((p) => !p.treatment_id).length} 例，无归属 ${orphansBefore.length} 例`);
const mission = backend.closeMission({ missionId: M, memberId: I.wang });
ok(`任务已关闭：共 ${mission.close_summary.total_patients} 例，治疗 ${mission.close_summary.treated} 例，转介 ${mission.close_summary.referred} 例`);

// 12 ── 返程后：访问边界与别名还原
step(11, "返程后：访问边界 + 从别名还原完整链路");
say("中方成员在任务范围内仍可读，不能再写；未授权医院不可见");
try {
  backend.registerScreening({
    missionId: M, batchId: "late", localName: "Late",
    verifierId: I.jonasa, registeredBy: I.chen,
  });
} catch (e) { ok(`关闭后中方写入被拒绝：${e.code}`); }

const printOutcome = (name, village) => {
  const [view] = backend.resolveByAlias({
    missionId: M, localName: name, village, actorId: I.jonasa,
  });
  const chain = view.trail.map((t) => t.stage).join(" → ");
  console.log(`\n  【${name} / ${village}】当前状态：${view.patient.status}`);
  console.log(`    链路：${chain}`);
  if (view.outcome.kind === "treated") {
    console.log(`    结局：已治疗（${view.outcome.procedure}，主刀 ${view.outcome.performed_by}）`);
  } else {
    console.log(`    结局：转介（${view.outcome.kind}）→ ${view.outcome.destination_hospital_id}`);
    console.log(`    后续责任人：${view.outcome.follow_up_owner.name}，承接状态：${view.outcome.referral_status}，期限：${view.outcome.follow_up_due_at ?? "未定"}`);
  }
};
printOutcome("Josefa Bole", "Nausori");
printOutcome("Asena Taga", "Nausori");
printOutcome("Semi Vula", "Nausori");
printOutcome("Wati Raile", "Lami");

console.log("\n" + "═".repeat(62));
console.log(`闭环校验：findOrphans = ${JSON.stringify(backend.findOrphans(M))}（空 = 返程后没有无人承接的记录）`);
console.log("═".repeat(62) + "\n");
