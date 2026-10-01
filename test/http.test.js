import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";

import { createApp } from "../src/main.js";
import { ids, M } from "./helpers.js";

async function startServer() {
  const app = await createApp({ seedPath: "fixtures/seed.json" });
  const server = createServer(app.handler);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  async function call(method, path, body, memberId) {
    const res = await fetch(`http://localhost:${port}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(memberId ? { "x-member-id": memberId } : {}),
      },
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
    });
    const json = await res.json();
    return { status: res.status, body: json };
  }
  return { server, call };
}

test("HTTP 全链路：筛查→离线同步(重传)→复核→同意→排程→治疗；重传不产生第二例", async () => {
  const { server, call } = await startServer();
  try {
    const reg = await call("POST", `/missions/${M}/batches/batch-village-1/screenings`, {
      localName: "Josefa HTTP", village: "Nausori",
      verifierId: ids.jonasa, deviceId: ids.device3,
    }, ids.ana);
    assert.equal(reg.status, 201);
    const pid = reg.body.patientId;

    const imgPayload = {
      batchId: "batch-village-1", deviceId: ids.device3, patientId: pid,
      contentHash: "sha256:http-1", assistSuggestion: { condition: "cataract" },
      clientSyncId: "dev3-tx-77",
    };
    const img1 = await call("POST", `/missions/${M}/images`, imgPayload, ids.ana);
    assert.equal(img1.status, 201);
    const img2 = await call("POST", `/missions/${M}/images`, imgPayload, ids.ana);
    assert.equal(img2.status, 200, "幂等重传返回 200");
    assert.equal(img2.body.imageId, img1.body.imageId);

    // 无身份 → 401
    const anon = await call("POST", `/patients/${pid}/reviews`, { missionId: M, decision: "eligible" });
    assert.equal(anon.status, 401);

    // 护士复核 → 403
    const nurse = await call("POST", `/patients/${pid}/reviews`, { missionId: M, decision: "eligible" }, ids.lin);
    assert.equal(nurse.status, 403);

    const review = await call("POST", `/patients/${pid}/reviews`, { missionId: M, decision: "eligible" }, ids.chen);
    assert.equal(review.status, 201);

    const consent = await call("POST", `/patients/${pid}/consents`, {
      missionId: M, languageVersion: "fj-Latn-fiji-2026", witnessId: ids.jonasa, signatureType: "thumbprint",
    }, ids.lin);
    assert.equal(consent.status, 201);

    const slot = await call("POST", `/patients/${pid}/slots`, {
      missionId: M, startAt: "2026-09-29T08:00:00.000Z", endAt: "2026-09-29T09:00:00.000Z",
      resourceIds: ["room-or-1", "eq-phaco-01", "eq-microscope-01"],
      staffIds: [ids.chen, ids.lin], consumables: { "cons-iol": 1 },
    }, ids.wang);
    assert.equal(slot.status, 201);

    const txPayload = { missionId: M, procedure: "phacoemulsification+IOL", clientTxId: "tab-1" };
    const tx1 = await call("POST", `/patients/${pid}/treatment`, txPayload, ids.chen);
    assert.equal(tx1.status, 201);
    const tx2 = await call("POST", `/patients/${pid}/treatment`, txPayload, ids.chen);
    assert.equal(tx2.status, 200);
    assert.equal(tx2.body.duplicate, true);
    assert.equal(tx2.body.id, tx1.body.id);

    // 别名还原
    const resolved = await call("GET", `/missions/${M}/resolve?local_name=josefa%20http&village=nausori`, null, ids.chen);
    assert.equal(resolved.status, 200);
    assert.equal(resolved.body[0].outcome.kind, "treated");
    assert.deepEqual(resolved.body[0].trail.map((t) => t.stage),
      ["screening", "image_synced", "physician_decision", "consent", "scheduling", "treatment"]);
  } finally {
    server.close();
  }
});

test("HTTP 加急挤占关键阶段返回 409 PROTECTED_PATIENT；未授权关闭被阻断", async () => {
  const { server, call } = await startServer();
  try {
    const admit = async (name, decision, reason) => {
      const reg = await call("POST", `/missions/${M}/batches/b/screenings`, {
        localName: name, village: "V", verifierId: ids.jonasa, deviceId: ids.device3,
      }, ids.ana);
      const pid = reg.body.patientId;
      await call("POST", `/missions/${M}/images`, {
        batchId: "b", deviceId: ids.device3, patientId: pid,
        contentHash: `h:${name}`, clientSyncId: `s:${name}`,
      }, ids.ana);
      await call("POST", `/patients/${pid}/reviews`, { missionId: M, decision, reason }, ids.chen);
      await call("POST", `/patients/${pid}/consents`, {
        missionId: M, languageVersion: "fj", witnessId: ids.jonasa,
      }, ids.lin);
      return pid;
    };

    const normal = await admit("Normal HTTP", "eligible");
    const urgent = await admit("Urgent HTTP", "green_channel", "急性视力丧失");

    const s1 = await call("POST", `/patients/${normal}/slots`, {
      missionId: M, startAt: "2026-09-29T08:00:00.000Z", endAt: "2026-09-29T10:00:00.000Z",
      resourceIds: ["room-or-1", "eq-phaco-01", "eq-microscope-01"], staffIds: [ids.chen],
    }, ids.wang);
    assert.equal(s1.status, 201);
    await call("POST", `/slots/${s1.body.id}/phase`, { missionId: M, phase: "preop" }, ids.chen);

    const blocked = await call("POST", `/patients/${urgent}/expedite`, {
      missionId: M, startAt: "2026-09-29T08:00:00.000Z", endAt: "2026-09-29T09:00:00.000Z",
      resourceIds: ["room-or-1", "eq-phaco-01"], staffIds: [ids.chen],
      reason: "急性视力丧失",
    }, ids.wang);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error, "PROTECTED_PATIENT");

    // 有未闭环患者时关闭 → 409
    await call("POST", `/missions/${M}/handovers`, { hospitalId: ids.hospital }, ids.wang);
    const close = await call("POST", `/missions/${M}/close`, {}, ids.wang);
    assert.equal(close.status, 409);
    assert.equal(close.body.error, "ORPHANED_PATIENTS");
    assert.ok(close.body.details.orphaned.some((o) => o.patientId === urgent));
  } finally {
    server.close();
  }
});

test("HTTP 身份边界：其他任务中方成员 403，未交接医院 403", async () => {
  const { server, call } = await startServer();
  try {
    const reg = await call("POST", `/missions/${M}/batches/b/screenings`, {
      localName: "Boundary", village: "V", verifierId: ids.jonasa,
    }, ids.ana);
    const pid = reg.body.patientId;

    const otherMission = await call("GET", `/patients/${pid}/timeline`, null, ids.other);
    assert.equal(otherMission.status, 403);
    assert.equal(otherMission.body.error, "OUT_OF_MISSION_SCOPE");

    const nadi = await call("GET", `/patients/${pid}/timeline`, null, ids.ram);
    assert.equal(nadi.status, 403);
    assert.equal(nadi.body.error, "NO_HANDOVER");

    const local = await call("GET", `/patients/${pid}/timeline`, null, ids.singh);
    assert.equal(local.status, 200);
  } finally {
    server.close();
  }
});
