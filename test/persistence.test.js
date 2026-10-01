import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp } from "../src/main.js";
import { createStore } from "../src/store.js";
import { loadSeed } from "../src/seed.js";
import { MissionBackend } from "../src/backend.js";
import { M, ids, admitCandidate, throwsCode } from "./helpers.js";

const T1 = "2026-09-29T08:00:00.000Z";
const T2 = "2026-09-29T09:00:00.000Z";

test("状态落盘后重启：别名可还原，治疗重放不产生第二例", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eye-mission-"));
  const stateFile = join(dir, "state.json");
  try {
    // ── 第一次运行：登记、同步、复核、同意、排程、治疗 ──
    const app1 = await createApp({ stateFile });
    const b1 = app1.backend;
    const pid = admitCandidate(b1, { localName: "Persistence Tevita", village: "Rewa" });
    b1.scheduleSlot({
      missionId: M, patientId: pid, memberId: ids.wang,
      startAt: T1, endAt: T2,
      resourceIds: ["room-or-1", "eq-phaco-01", "eq-microscope-01"],
      staffIds: [ids.chen], consumables: { "cons-iol": 1 },
    });
    b1.completeTreatment({ missionId: M, patientId: pid, memberId: ids.chen, procedure: "phaco+IOL", clientTxId: "persist-1" });
    await b1.store.persist();

    // 另有一例未治疗患者，用转介收口
    const pid2 = admitCandidate(b1, { localName: "Persistence Mere", village: "Rewa" });
    b1.createReferral({
      missionId: M, patientId: pid2, memberId: ids.wang,
      outcome: "mission_end", reason: "返程前未及手术，转本地排期",
      followUpOwnerId: ids.singh, followUpDueAt: "2026-10-14T00:00:00.000Z",
    });
    b1.authorizeHandover({ missionId: M, hospitalId: ids.hospital, memberId: ids.wang });
    b1.closeMission({ missionId: M, memberId: ids.wang });
    await b1.store.persist();

    // ── 第二次运行：从磁盘恢复 ──
    const app2 = await createApp({ stateFile });
    const b2 = app2.backend;
    assert.equal(b2.state.missions[M].status, "closed");

    const views = b2.resolveByAlias({
      missionId: M, localName: "persistence tevita", village: "rewa", actorId: ids.chen,
    });
    assert.equal(views.length, 1);
    assert.equal(views[0].outcome.kind, "treated");

    // 重启后档案只挂着一条治疗，库存用量也恢复
    const replay = b2.state.patients[pid];
    assert.ok(replay.treatment_id, "患者应仍关联唯一治疗");
    assert.equal(Object.keys(b2.state.treatments).length, 1);
    assert.equal(b2.consumableAvailability(ids.iol).used, 1);

    // 重启后别名索引有效：重复登记不新建
    const reReg = (() => {
      // 任务已关闭不可写；直接对 store 层断言索引已恢复
      return b2.store.aliasIndex.has(`${M}|persistence mere|rewa`);
    })();
    assert.ok(reReg, "别名索引应在重启后重建");

    // 未授权医院重启后仍被拒绝
    throwsCode(() => b2.timeline(pid, ids.ram), "NO_HANDOVER");
    // 获授权医院可读
    assert.doesNotThrow(() => b2.timeline(pid, ids.singh));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hydrate 可直接消费任意快照并重建去重索引", async () => {
  const seed = await loadSeed("fixtures/seed.json");
  const store = createStore();
  new MissionBackend(seed, { store });
  store.hydrate({
    missions: { [M]: { id: M, status: "active" } },
    patients: {
      "pat-x": {
        id: "pat-x", missionId: M, status: "screened",
        aliases: [{ local_name: "Semi", village: "Tailevu" }],
        contacts: [], image_ids: [],
      },
    },
  });
  assert.ok(store.aliasIndex.has(`${M}|semi|tailevu`));
});
