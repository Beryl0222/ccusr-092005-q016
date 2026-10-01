import { DomainError } from "./errors.js";

/**
 * 零依赖 HTTP 适配层：将 JSON 请求映射到 MissionBackend。
 * 调用方身份通过 x-member-id 请求头传递（流动内网/反向代理终止 TLS）。
 */
export function createHandler(backend) {
  const json = (res, status, payload) => {
    const body = JSON.stringify(payload);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(body);
  };

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let raw = "";
      req.on("data", (c) => {
        raw += c;
        if (raw.length > 2_000_000) reject(new DomainError("请求体过大", { status: 413 }));
      });
      req.on("end", () => {
        if (!raw) return resolve({});
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new DomainError("请求体不是合法 JSON", { code: "BAD_JSON", status: 400 }));
        }
      });
      req.on("error", reject);
    });

  const handler = async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const p = url.pathname.replace(/\/+$/, "");
      const body = req.method === "POST" ? await readBody(req) : {};
      const actorId = req.headers["x-member-id"] || body.actorId || body.memberId;
      const ctx = { actorId, body, url, p };

      const route = matchRoute(req.method, p);
      if (!route) return json(res, 404, { error: "NOT_FOUND", message: `无此路由: ${req.method} ${p}` });

      // 任何业务路由都需要可识别的成员身份
      if (!actorId) {
        return json(res, 401, { error: "UNAUTHENTICATED", message: "缺少 x-member-id 身份头" });
      }

      const args = buildArgs(route, body, url);
      const result = await dispatch(backend, route.action, args, ctx);
      if (req.method === "POST") await backend.store.persist();
      const creates = ["screening", "image", "review", "consent", "slot", "expedite", "treatment", "referral", "handover", "equipmentFailure"];
      const status = creates.includes(route.action) && !result.replayed && !result.duplicate ? 201 : 200;
      return json(res, status, result);
    } catch (err) {
      if (err instanceof DomainError) {
        return json(res, err.status, { error: err.code, message: err.message, details: err.details });
      }
      return json(res, 500, { error: "INTERNAL", message: String(err?.message ?? err) });
    }
  };

  return handler;
}

function matchRoute(method, p) {
  const routes = [
    ["POST", /^\/missions\/([^/]+)\/handovers$/, "handover"],
    ["POST", /^\/missions\/([^/]+)\/close$/, "close"],
    ["GET", /^\/missions\/([^/]+)\/orphans$/, "orphans"],
    ["GET", /^\/missions\/([^/]+)\/audit$/, "audit"],
    ["POST", /^\/missions\/([^/]+)\/batches\/([^/]+)\/screenings$/, "screening"],
    ["POST", /^\/missions\/([^/]+)\/images$/, "image"],
    ["POST", /^\/missions\/([^/]+)\/equipment\/([^/]+)\/failure$/, "equipmentFailure"],
    ["GET", /^\/missions\/([^/]+)\/resolve$/, "resolve"],
    ["POST", /^\/patients\/([^/]+)\/reviews$/, "review"],
    ["POST", /^\/patients\/([^/]+)\/consents$/, "consent"],
    ["POST", /^\/patients\/([^/]+)\/slots$/, "slot"],
    ["POST", /^\/patients\/([^/]+)\/expedite$/, "expedite"],
    ["POST", /^\/patients\/([^/]+)\/treatment$/, "treatment"],
    ["POST", /^\/patients\/([^/]+)\/referral$/, "referral"],
    ["GET", /^\/patients\/([^/]+)\/timeline$/, "timeline"],
    ["POST", /^\/slots\/([^/]+)\/phase$/, "phase"],
    ["POST", /^\/referrals\/([^/]+)\/acknowledge$/, "acknowledge"],
    ["GET", /^\/consumables\/([^/]+)$/, "consumable"],
  ];
  for (const [m, re, action] of routes) {
    if (m !== method) continue;
    const mm = p.match(re);
    if (mm) return { action, params: mm.slice(1) };
  }
  return null;
}

function buildArgs(route, body, url) {
  const [a, b] = route.params;
  return { a, b, body, query: Object.fromEntries(url.searchParams) };
}

async function dispatch(backend, action, { a, b, body, query }, { actorId }) {
  switch (action) {
    case "handover":
      return backend.authorizeHandover({ missionId: a, hospitalId: body.hospitalId, memberId: actorId, scope: body.scope });
    case "close":
      return backend.closeMission({ missionId: a, memberId: actorId });
    case "orphans":
      backend._authorize(a, actorId, { write: false });
      return { orphans: backend.findOrphans(a) };
    case "audit":
      return { events: backend.listAudit(a, actorId) };
    case "screening":
      return backend.registerScreening({
        missionId: a,
        batchId: b,
        localName: body.localName,
        locale: body.locale,
        village: body.village,
        demographics: body.demographics,
        verifierId: body.verifierId,
        registeredBy: actorId,
        deviceId: body.deviceId,
      });
    case "image":
      return backend.syncImageSummary({
        missionId: a,
        batchId: body.batchId,
        deviceId: body.deviceId,
        patientId: body.patientId,
        contentHash: body.contentHash,
        capturedAt: body.capturedAt,
        assistSuggestion: body.assistSuggestion,
        clientSyncId: body.clientSyncId,
        actorId,
      });
    case "equipmentFailure":
      return backend.reportEquipmentFailure({
        missionId: a,
        equipmentId: b,
        memberId: actorId,
        reason: body.reason,
        affectedPatientIds: body.affectedPatientIds,
        followUpOwnerId: body.followUpOwnerId,
        followUpDueAt: body.followUpDueAt,
      });
    case "resolve":
      return backend.resolveByAlias({
        missionId: a,
        localName: query.local_name,
        locale: query.locale,
        village: query.village,
        actorId,
      });
    case "review":
      return backend.reviewPatient({
        missionId: body.missionId,
        patientId: a,
        doctorId: actorId,
        decision: body.decision,
        reason: body.reason,
        findings: body.findings,
      });
    case "consent":
      return backend.recordConsent({
        missionId: body.missionId,
        patientId: a,
        memberId: actorId,
        languageVersion: body.languageVersion,
        witnessId: body.witnessId,
        signatureType: body.signatureType,
        textVersion: body.textVersion,
      });
    case "slot":
      return backend.scheduleSlot({
        missionId: body.missionId,
        patientId: a,
        memberId: actorId,
        startAt: body.startAt,
        endAt: body.endAt,
        resourceIds: body.resourceIds,
        staffIds: body.staffIds,
        consumables: body.consumables,
        note: body.note,
      });
    case "expedite":
      return backend.expediteSlot({
        missionId: body.missionId,
        patientId: a,
        coordinatorId: actorId,
        startAt: body.startAt,
        endAt: body.endAt,
        resourceIds: body.resourceIds,
        staffIds: body.staffIds,
        consumables: body.consumables,
        reason: body.reason,
      });
    case "treatment":
      return backend.completeTreatment({
        missionId: body.missionId,
        patientId: a,
        memberId: actorId,
        procedure: body.procedure,
        performedAt: body.performedAt,
        clientTxId: body.clientTxId,
        details: body.details,
      });
    case "referral":
      return backend.createReferral({
        missionId: body.missionId,
        patientId: a,
        memberId: actorId,
        outcome: body.outcome,
        reason: body.reason,
        destinationHospitalId: body.destinationHospitalId,
        followUpOwnerId: body.followUpOwnerId,
        followUpDueAt: body.followUpDueAt,
        notes: body.notes,
      });
    case "timeline":
      return backend.timeline(a, actorId);
    case "phase":
      return backend.advancePhase({
        missionId: body.missionId,
        slotId: a,
        memberId: actorId,
        phase: body.phase,
      });
    case "acknowledge":
      return backend.acknowledgeReferral({ missionId: body.missionId, referralId: a, memberId: actorId });
    case "consumable":
      return backend.consumableAvailability(a);
    default:
      throw new DomainError("未实现的动作", { status: 501 });
  }
}
