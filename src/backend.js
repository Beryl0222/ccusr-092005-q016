// 流动眼科行动协同后端：纯领域逻辑，无外部依赖，可被 HTTP 层或离线同步进程直接调用。
// 所有写方法都是幂等的：同一客户端记录重复同步不会产生第二例业务实体。

export class DomainError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}

const STAGES = {
  SCHEDULED: "scheduled", // 已排程，尚未进入关键阶段
  PREPPED: "prepped", // 已术前准备（关键阶段）
  IN_SURGERY: "in_surgery", // 已进手术室/手术中（关键阶段）
  COMPLETED: "completed",
  CANCELLED: "cancelled",
};

const CRITICAL_STAGES = new Set([STAGES.PREPPED, STAGES.IN_SURGERY]);

const QUALIFIED_REFERRAL_ROLES = new Set(["doctor", "nurse", "coordinator"]);

let seq = 0;
const newId = (prefix) => `${prefix}-${(++seq).toString(36)}-${Date.now().toString(36)}`;

export class MissionBackend {
  constructor() {
    this.missions = new Map();
    this.orgs = new Map();
    this.staff = new Map();
    this.devices = new Map();
    this.rooms = new Map();
    this.sites = new Map();
    this.consumables = new Map();
    this.missionRoster = new Map(); // missionId -> Set(staffId)

    this.patients = new Map();
    this.aliasIndex = new Map(); // `${missionId}:${proofType}:${proofRef}` -> patientId
    this.batches = new Map(); // 客户端 batchId -> 批次记录（幂等键）
    this.findings = new Map(); // findingId -> 图像摘要/辅助判断
    this.findingHashIndex = new Map(); // `${patientId}:${contentHash}` -> findingId（跨设备去重）
    this.decisions = []; // 医生人工决定
    this.consents = new Map(); // consentId
    this.slots = new Map(); // slotId -> {booking}
    this.staffLocks = new Map(); // `${date}:${index}:${staffId}` -> slotId
    this.equipmentLocks = new Map(); // `${date}:${index}:${deviceId}` -> slotId
    this.treatments = new Map(); // treatmentId
    this.treatmentIdempotency = new Map(); // 客户端记录键 -> treatmentId
    this.referrals = new Map(); // referralId
    this.referralDedupe = new Map(); // `${patientId}:${reason}` -> referralId
    this.auditLog = [];
    this.handoverGrants = []; // 授权交接记录
  }

  log(event, payload = {}) {
    this.auditLog.push({ at: new Date().toISOString(), event, ...payload });
  }

  // ---------- 资料装配 ----------

  loadSeed(data) {
    const newMissions = [];
    const newStaff = [];
    for (const r of data.records ?? []) {
      if (r.kind === "org") this.orgs.set(r.id, r);
      else if (r.kind === "mission") {
        if (!this.missions.has(r.id)) {
          this.missions.set(r.id, { ...r, status: "active", handover: null });
          newMissions.push(r.id);
        }
      } else if (r.kind === "staff") {
        if (!this.staff.has(r.id)) {
          this.staff.set(r.id, { ...r, qualifications: new Set(r.qualifications ?? []) });
          newStaff.push(r);
        }
      } else if (r.kind === "screening_device" || r.kind === "operating_equipment") this.devices.set(r.id, { ...r, status: "ok" });
      else if (r.kind === "operating_room") this.rooms.set(r.id, { ...r });
      else if (r.kind === "screening_site") this.sites.set(r.id, { ...r });
      else if (r.kind === "consumable") this.consumables.set(r.id, { ...r, reserved: 0, used: 0 });
    }
    // 人员名册按任务划定访问边界。新任务先建空名册；
    // 资料未注明任务归属的新人员默认进入本次装配时已存在的全部任务，后续新任务须显式编入。
    for (const missionId of newMissions) this.missionRoster.set(missionId, new Set());
    const currentMissions = [...this.missions.keys()];
    for (const s of newStaff) {
      for (const missionId of s.mission_ids ?? currentMissions) this.missionRoster.get(missionId)?.add(s.id);
    }
    this.log("seed_loaded", { records: data.records?.length ?? 0 });
  }

  assignStaff(missionId, staffId) {
    if (!this.missions.has(missionId)) throw new DomainError("MISSION_NOT_FOUND", `未知任务：${missionId}`);
    this.#requireStaff(staffId);
    this.missionRoster.get(missionId).add(staffId);
    this.log("staff_assigned", { missionId, staffId });
  }

  createSlots(roomId, date, labels) {
    const room = this.rooms.get(roomId);
    if (!room) throw new DomainError("ROOM_NOT_FOUND", `未知手术室：${roomId}`);
    return labels.map((label, index) => {
      const slot = { id: newId("slot"), roomId, date, index, label, booking: null };
      this.slots.set(slot.id, slot);
      return slot;
    });
  }

  // ---------- 访问控制 ----------
  // 中方成员仅访问任务范围；本地医院在获授权交接后继续查看。

  #requireStaff(staffId) {
    const s = this.staff.get(staffId);
    if (!s) throw new DomainError("UNAUTHENTICATED", `未知人员：${staffId}`);
    return s;
  }

  #isChineseTeam(staff) {
    return this.orgs.get(staff.org_id)?.scope === "visiting_team";
  }

  canViewPatient(staffId, patientId) {
    try {
      this.assertViewPatient(staffId, patientId);
      return true;
    } catch {
      return false;
    }
  }

  assertViewPatient(staffId, patientId) {
    const viewer = this.#requireStaff(staffId);
    const patient = this.patients.get(patientId);
    if (!patient) throw new DomainError("PATIENT_NOT_FOUND", `未知患者：${patientId}`);
    const mission = this.missions.get(patient.missionId);

    if (this.#isChineseTeam(viewer)) {
      const roster = this.missionRoster.get(patient.missionId);
      if (!roster?.has(staffId)) {
        throw new DomainError("OUT_OF_SCOPE", "中方成员仅可访问本任务名册内的患者");
      }
      // 返程并完成授权交接后，流动队访问冻结，由本地团队承接。
      if (mission.status === "closed") {
        throw new DomainError("MISSION_CLOSED", "任务已结束并交接，流动队访问已关闭");
      }
      return true;
    }

    // 本地医院：任务期间因分工（复核/见证/责任人）获得访问；交接授权后全量续看。
    if (this.#isPatientAssignee(staffId, patientId)) return true;
    const grant = mission.handover;
    if (grant && grant.toOrgId === viewer.org_id) return true;
    throw new DomainError("NOT_AUTHORIZED", "未获授权：本地医院需在交接授权后查看该患者");
  }

  #isPatientAssignee(staffId, patientId) {
    if (this.decisions.some((d) => d.patientId === patientId && d.reviewerId === staffId)) return true;
    if ([...this.consents.values()].some((c) => c.patientId === patientId && c.witnessId === staffId)) return true;
    if ([...this.referrals.values()].some((r) => r.patientId === patientId && r.responsiblePersonId === staffId)) return true;
    for (const slot of this.slots.values()) {
      if (slot.booking?.patientId === patientId && slot.booking.staffIds.includes(staffId)) return true;
    }
    return false;
  }

  // ---------- 患者别名与筛查批次 ----------

  // 以当地可核验别名进入筛查批次：别名 + 可核验凭证（社区名册/指纹编号/证件），由在场人员核验。
  registerPatient({ missionId, alias, proofType, proofRef, verifiedBy, batchClientId, siteId }) {
    const mission = this.missions.get(missionId);
    if (!mission) throw new DomainError("MISSION_NOT_FOUND", `未知任务：${missionId}`);
    const verifier = this.#requireStaff(verifiedBy);
    if (!alias || !proofType || !proofRef) {
      throw new DomainError("ALIAS_UNVERIFIABLE", "别名必须附带可核验凭证类型与编号");
    }
    const key = `${missionId}:${proofType}:${proofRef.trim()}`;
    const existing = this.aliasIndex.get(key);
    if (existing) {
      // 同一可核验别名重复登记：回到同一例患者，绝不另建。
      const patient = this.patients.get(existing);
      if (!patient.aliases.some((a) => a.value === alias)) {
        patient.aliases.push({ value: alias, proofType, proofRef: proofRef.trim(), verifiedBy, verifiedAt: new Date().toISOString() });
      }
      return { patient, duplicated: true };
    }
    const patient = {
      id: newId("patient"),
      missionId,
      aliases: [{ value: alias, proofType, proofRef: proofRef.trim(), verifiedBy, verifiedAt: new Date().toISOString() }],
      siteId,
      status: "screened",
      createdAt: new Date().toISOString(),
    };
    this.patients.set(patient.id, patient);
    this.aliasIndex.set(key, patient.id);
    this.log("patient_registered", { patientId: patient.id, missionId, alias, verifiedBy, batchClientId });
    return { patient, duplicated: false };
  }

  resolveByAlias(missionId, alias) {
    for (const patient of this.patients.values()) {
      if (patient.missionId === missionId && patient.aliases.some((a) => a.value === alias)) return patient;
    }
    return null;
  }

  // ---------- 离线回传：图像摘要与辅助判断去重合并 ----------

  // 便携设备离线产生批次；联网后按客户端 batchId 幂等接收。
  // rows: [{clientRowId, alias, proofType, proofRef, images:[{contentHash, summary, assistVerdict}], capturedAt}]
  syncScreeningBatch({ missionId, deviceId, batchClientId, capturedOfflineAt, rows }) {
    const device = this.devices.get(deviceId);
    if (!device) throw new DomainError("DEVICE_NOT_FOUND", `未知设备：${deviceId}`);
    if (!batchClientId) throw new DomainError("BATCH_ID_REQUIRED", "离线批次必须携带客户端批次号");

    const existing = this.batches.get(batchClientId);
    if (existing) {
      // 重复同步：原样返回已合并结果，不产生第二例记录。
      return { duplicated: true, batch: existing, mergedFindings: existing.findingIds.map((id) => this.findings.get(id)) };
    }

    const batch = {
      id: newId("batch"),
      batchClientId,
      missionId,
      deviceId,
      capturedOfflineAt,
      syncedAt: new Date().toISOString(),
      rowIds: [],
      findingIds: [],
    };
    this.batches.set(batchClientId, batch);

    for (const row of rows) {
      const { patient } = this.registerPatient({
        missionId,
        alias: row.alias,
        proofType: row.proofType,
        proofRef: row.proofRef,
        verifiedBy: row.verifiedBy,
        batchClientId,
      });
      batch.rowIds.push(row.clientRowId);
      for (const image of row.images ?? []) {
        const dedupeKey = `${patient.id}:${image.contentHash}`;
        let findingId = this.findingHashIndex.get(dedupeKey);
        if (findingId) {
          // 同一图像摘要跨设备/跨批次重复回传：合并来源，不新建判断。
          const finding = this.findings.get(findingId);
          finding.sources.push({ deviceId, batchClientId, clientRowId: row.clientRowId, syncedAt: batch.syncedAt });
          batch.findingIds.push(findingId);
          continue;
        }
        findingId = newId("finding");
        this.findings.set(findingId, {
          id: findingId,
          patientId: patient.id,
          contentHash: image.contentHash,
          summary: image.summary,
          assistVerdict: image.assistVerdict ?? null, // 仅为辅助判断
          assistReviewed: false,
          sources: [{ deviceId, batchClientId, clientRowId: row.clientRowId, syncedAt: batch.syncedAt }],
          capturedAt: row.capturedAt ?? image.capturedAt ?? capturedOfflineAt,
        });
        this.findingHashIndex.set(dedupeKey, findingId);
        batch.findingIds.push(findingId);
      }
    }
    this.log("screening_batch_synced", { batchClientId, deviceId, rows: rows.length, findings: batch.findingIds.length });
    return { duplicated: false, batch, mergedFindings: batch.findingIds.map((id) => this.findings.get(id)) };
  }

  // ---------- 医生复核：辅助判断不得直接进入治疗路径 ----------

  reviewByDoctor({ patientId, reviewerId, decision, note, findingIds = [] }) {
    const patient = this.patients.get(patientId);
    if (!patient) throw new DomainError("PATIENT_NOT_FOUND", `未知患者：${patientId}`);
    const reviewer = this.#requireStaff(reviewerId);
    if (!reviewer.qualifications.has("doctor")) {
      throw new DomainError("DOCTOR_ONLY", "只有医生可复核并决定治疗路径");
    }
    if (!["candidate", "observe", "not_candidate", "refer_out"].includes(decision)) {
      throw new DomainError("BAD_DECISION", `非法复核结论：${decision}`);
    }
    for (const fid of findingIds) {
      const finding = this.findings.get(fid);
      if (!finding || finding.patientId !== patientId) {
        throw new DomainError("FINDING_MISMATCH", "复核的图像摘要不属于该患者");
      }
      finding.assistReviewed = true;
    }
    const record = {
      id: newId("decision"),
      patientId,
      reviewerId,
      decision,
      note: note ?? null,
      findingIds: [...findingIds],
      at: new Date().toISOString(),
    };
    this.decisions.push(record);
    if (decision === "candidate") patient.status = "candidate";
    this.log("doctor_reviewed", { patientId, reviewerId, decision });
    return record;
  }

  #latestDecision(patientId) {
    for (let i = this.decisions.length - 1; i >= 0; i--) {
      if (this.decisions[i].patientId === patientId) return this.decisions[i];
    }
    return null;
  }

  // ---------- 知情同意：语言版本 + 见证人 ----------

  recordConsent({ patientId, languageVersion, witnessId, textHash, signedAt, translatedFrom }) {
    const patient = this.patients.get(patientId);
    if (!patient) throw new DomainError("PATIENT_NOT_FOUND", `未知患者：${patientId}`);
    if (!languageVersion) throw new DomainError("CONSENT_LANGUAGE_REQUIRED", "必须保存知情同意的语言版本");
    if (!textHash) throw new DomainError("CONSENT_TEXT_REQUIRED", "缺少同意书内容指纹");
    const witness = this.#requireStaff(witnessId);
    if (!witness.qualifications.has("witness")) {
      throw new DomainError("WITNESS_QUALIFIED_ONLY", "见证人须为具备见证资格的在册人员");
    }
    // 翻译变更：同一语言版本重复签署保持一条；新版本留痕，不覆盖旧版本。
    const dup = [...this.consents.values()].find(
      (c) => c.patientId === patientId && c.languageVersion === languageVersion && c.textHash === textHash,
    );
    if (dup) return { duplicated: true, consent: dup };

    const consent = {
      id: newId("consent"),
      patientId,
      languageVersion,
      translatedFrom: translatedFrom ?? null,
      witnessId,
      textHash,
      signedAt: signedAt ?? new Date().toISOString(),
    };
    this.consents.set(consent.id, consent);
    this.log("consent_recorded", { patientId, languageVersion, witnessId });
    return { duplicated: false, consent };
  }

  // ---------- 资源锁定：手术室/设备/人员/耗材 按时段 ----------

  #findSlot(slotId) {
    const slot = this.slots.get(slotId);
    if (!slot) throw new DomainError("SLOT_NOT_FOUND", `未知时段：${slotId}`);
    return slot;
  }

  #checkResources({ date, index, staffIds, equipmentIds, consumables }) {
    for (const staffId of staffIds ?? []) {
      this.#requireStaff(staffId);
      if (this.staffLocks.has(`${date}:${index}:${staffId}`)) {
        throw new DomainError("STAFF_CONFLICT", `人员 ${staffId} 在该时段已有锁定`, { staffId });
      }
    }
    for (const deviceId of equipmentIds ?? []) {
      const device = this.devices.get(deviceId);
      if (!device) throw new DomainError("DEVICE_NOT_FOUND", `未知设备：${deviceId}`);
      if (device.status === "failed") {
        throw new DomainError("EQUIPMENT_FAILED", `设备 ${deviceId} 已故障，不可锁定`);
      }
      if (this.equipmentLocks.has(`${date}:${index}:${deviceId}`)) {
        throw new DomainError("EQUIPMENT_CONFLICT", `设备 ${deviceId} 在该时段已被锁定`, { deviceId });
      }
    }
    for (const [consId, qty] of Object.entries(consumables ?? {})) {
      const cons = this.consumables.get(consId);
      if (!cons) throw new DomainError("CONSUMABLE_NOT_FOUND", `未知耗材：${consId}`);
      if (cons.stock - cons.reserved - cons.used < qty) {
        throw new DomainError("CONSUMABLE_SHORTAGE", `耗材 ${cons.name} 可用量不足`, { consId });
      }
    }
  }

  #applyLocks(slot, booking, { staffIds, equipmentIds, consumables }) {
    const { date, index } = slot;
    for (const staffId of staffIds ?? []) this.staffLocks.set(`${date}:${index}:${staffId}`, slot.id);
    for (const deviceId of equipmentIds ?? []) this.equipmentLocks.set(`${date}:${index}:${deviceId}`, slot.id);
    for (const [consId, qty] of Object.entries(consumables ?? {})) {
      const cons = this.consumables.get(consId);
      cons.reserved += qty;
      booking.consumables[consId] = qty;
    }
  }

  #releaseLocks(slot) {
    const booking = slot.booking;
    if (!booking) return;
    const { date, index } = slot;
    for (const staffId of booking.staffIds ?? []) this.staffLocks.delete(`${date}:${index}:${staffId}`);
    for (const deviceId of booking.equipmentIds ?? []) this.equipmentLocks.delete(`${date}:${index}:${deviceId}`);
    for (const [consId, qty] of Object.entries(booking.consumables ?? {})) {
      this.consumables.get(consId).reserved -= qty;
    }
  }

  lockSlot({ slotId, patientId, staffIds = [], equipmentIds = [], consumables = {}, greenChannel = null }) {
    const slot = this.#findSlot(slotId);
    const patient = this.patients.get(patientId);
    if (!patient) throw new DomainError("PATIENT_NOT_FOUND", `未知患者：${patientId}`);
    const decision = this.#latestDecision(patientId);
    if (greenChannel) {
      if (!greenChannel.reason || !greenChannel.requestedBy) {
        throw new DomainError("GREEN_REASON_REQUIRED", "绿色通道必须记录理由和申请人");
      }
    } else {
      if (decision?.decision !== "candidate") {
        throw new DomainError("NOT_CANDIDATE", "只有医生复核为候选的患者可锁定治疗时段");
      }
    }
    if (slot.booking && CRITICAL_STAGES.has(slot.booking.stage)) {
      throw new DomainError("CRITICAL_PROTECTED", "该时段患者已进入关键阶段，任何人不得挤占", {
        occupantPatientId: slot.booking.patientId,
        stage: slot.booking.stage,
      });
    }

    // 非关键阶段占台者：先为其找到同时段/其他空闲替代，找不到则拒绝加塞——不制造无人承接。
    let displaced = null;
    if (slot.booking) {
      displaced = slot.booking;
      const alt = this.#findAlternativeSlot({ booking: displaced, staffIds, equipmentIds, consumables });
      if (!alt) throw new DomainError("NO_REPLACEMENT_SLOT", "加塞会挤出已排程患者且无替代时段，已拒绝");
      this.#moveBooking(slot, alt);
    }

    this.#checkResources({ date: slot.date, index: slot.index, staffIds, equipmentIds, consumables });

    const booking = {
      id: newId("booking"),
      patientId,
      stage: STAGES.SCHEDULED,
      staffIds: [...staffIds],
      equipmentIds: [...equipmentIds],
      consumables: {},
      greenChannel: greenChannel ? { reason: greenChannel.reason, requestedBy: greenChannel.requestedBy, at: new Date().toISOString() } : null,
      treatmentId: null,
    };
    slot.booking = booking;
    this.#applyLocks(slot, booking, { staffIds, equipmentIds, consumables });
    this.log("slot_locked", { slotId: slot.id, patientId, displacedPatientId: displaced?.patientId ?? null, green: !!greenChannel });
    return { booking, displacedTo: displaced ? this.#slotOfBooking(displaced.id)?.id ?? null : null };
  }

  #slotOfBooking(bookingId) {
    for (const slot of this.slots.values()) if (slot.booking?.id === bookingId) return slot;
    return null;
  }

  #findAlternativeSlot({ booking, staffIds, equipmentIds, consumables }) {
    for (const candidate of this.slots.values()) {
      if (candidate.booking) continue;
      const clashStaff = staffIds.some((sid) => booking.staffIds.includes(sid));
      const clashEquip = equipmentIds.some((did) => booking.equipmentIds.includes(did));
      if (clashStaff || clashEquip) continue; // 与加塞需求共用资源的时段不能安置被挤者
      try {
        this.#checkResources({ date: candidate.date, index: candidate.index, staffIds: booking.staffIds, equipmentIds: booking.equipmentIds, consumables: booking.consumables });
      } catch {
        continue;
      }
      return candidate;
    }
    return null;
  }

  #moveBooking(from, to) {
    const booking = from.booking;
    this.#releaseLocks(from);
    from.booking = null;
    to.booking = booking;
    this.#applyLocks(to, booking, { staffIds: booking.staffIds, equipmentIds: booking.equipmentIds, consumables: booking.consumables });
    this.log("booking_moved", { bookingId: booking.id, patientId: booking.patientId, fromSlotId: from.id, toSlotId: to.id });
  }

  advanceStage(bookingId, stage) {
    const slot = this.#slotOfBooking(bookingId);
    if (!slot) throw new DomainError("BOOKING_NOT_FOUND", `未知排程：${bookingId}`);
    if (![STAGES.PREPPED, STAGES.IN_SURGERY, STAGES.COMPLETED].includes(stage)) {
      throw new DomainError("BAD_STAGE", `非法阶段：${stage}`);
    }
    slot.booking.stage = stage;
    this.log("stage_advanced", { bookingId, stage });
    return slot.booking;
  }

  // ---------- 治疗：知情同意前置 + 重复同步不创建第二例 ----------

  startTreatment({ bookingId, procedure, clientRecordId, startedBy }) {
    const slot = this.#slotOfBooking(bookingId);
    if (!slot) throw new DomainError("BOOKING_NOT_FOUND", `未知排程：${bookingId}`);
    const booking = slot.booking;
    const patientId = booking.patientId;

    // 幂等：同一客户端记录键（离线治疗单/同步批次行）重复提交只返回同一例。
    if (clientRecordId && this.treatmentIdempotency.has(`${bookingId}:${clientRecordId}`)) {
      const id = this.treatmentIdempotency.get(`${bookingId}:${clientRecordId}`);
      return { duplicated: true, treatment: this.treatments.get(id) };
    }
    if (booking.treatmentId) {
      return { duplicated: true, treatment: this.treatments.get(booking.treatmentId) };
    }
    if (![...this.consents.values()].some((c) => c.patientId === patientId)) {
      throw new DomainError("CONSENT_MISSING", "开始治疗前必须保存带见证人的知情同意");
    }

    const treatment = {
      id: newId("treatment"),
      patientId,
      bookingId,
      procedure,
      status: "in_progress",
      startedBy,
      startedAt: new Date().toISOString(),
      completedAt: null,
    };
    this.treatments.set(treatment.id, treatment);
    booking.treatmentId = treatment.id;
    booking.stage = STAGES.IN_SURGERY;
    if (clientRecordId) this.treatmentIdempotency.set(`${bookingId}:${clientRecordId}`, treatment.id);
    this.log("treatment_started", { treatmentId: treatment.id, patientId, procedure });
    return { duplicated: false, treatment };
  }

  completeTreatment(treatmentId) {
    const treatment = this.treatments.get(treatmentId);
    if (!treatment) throw new DomainError("TREATMENT_NOT_FOUND", `未知治疗：${treatmentId}`);
    const slot = this.#slotOfBooking(treatment.bookingId);
    treatment.status = "completed";
    treatment.completedAt = new Date().toISOString();
    if (slot) {
      slot.booking.stage = STAGES.COMPLETED;
      for (const [consId, qty] of Object.entries(slot.booking.consumables ?? {})) {
        const cons = this.consumables.get(consId);
        cons.reserved -= qty;
        cons.used += qty;
      }
    }
    this.patients.get(treatment.patientId).status = "treated";
    this.log("treatment_completed", { treatmentId, patientId: treatment.patientId });
    return treatment;
  }

  // ---------- 转介：退出 / 设备故障 / 任务结束 都必须有明确责任人 ----------

  #createReferral({ patientId, reason, responsiblePersonId, followUpPlan, details = {} }) {
    const patient = this.patients.get(patientId);
    if (!patient) throw new DomainError("PATIENT_NOT_FOUND", `未知患者：${patientId}`);
    if (!responsiblePersonId) throw new DomainError("RESPONSIBLE_REQUIRED", "转介必须指定明确责任人");
    const person = this.#requireStaff(responsiblePersonId);
    if (![...person.qualifications].some((q) => QUALIFIED_REFERRAL_ROLES.has(q))) {
      throw new DomainError("RESPONSIBLE_UNQUALIFIED", "责任人须为本地医生、护士或协调员");
    }
    if (this.orgs.get(person.org_id)?.scope !== "local_hospital") {
      throw new DomainError("RESPONSIBLE_LOCAL_ONLY", "后续责任人必须来自本地承接医院");
    }
    if (!followUpPlan) throw new DomainError("FOLLOWUP_PLAN_REQUIRED", "转介必须写明后续安排");

    const dedupeKey = `${patientId}:${reason}`;
    const existingId = this.referralDedupe.get(dedupeKey);
    if (existingId) return { duplicated: true, referral: this.referrals.get(existingId) };

    const referral = {
      id: newId("referral"),
      patientId,
      reason, // patient_withdrawal | equipment_failure | mission_close | pending_review
      responsiblePersonId,
      followUpPlan,
      status: "open",
      details,
      createdAt: new Date().toISOString(),
      acknowledgedAt: null,
    };
    this.referrals.set(referral.id, referral);
    this.referralDedupe.set(dedupeKey, referral.id);
    this.log("referral_created", { referralId: referral.id, patientId, reason, responsiblePersonId });
    return { duplicated: false, referral };
  }

  acknowledgeReferral(referralId, byStaffId) {
    const referral = this.referrals.get(referralId);
    if (!referral) throw new DomainError("REFERRAL_NOT_FOUND", `未知转介：${referralId}`);
    referral.status = "acknowledged";
    referral.acknowledgedAt = new Date().toISOString();
    referral.acknowledgedBy = byStaffId;
    this.log("referral_acknowledged", { referralId, byStaffId });
    return referral;
  }

  #cancelBooking(patientId) {
    for (const slot of this.slots.values()) {
      if (slot.booking?.patientId === patientId && ![STAGES.COMPLETED, STAGES.CANCELLED].includes(slot.booking.stage)) {
        this.#releaseLocks(slot);
        slot.booking.stage = STAGES.CANCELLED;
        slot.booking = null;
      }
    }
  }

  // 患者退出：释放资源并生成带责任人的转介。
  patientWithdraw({ patientId, reason, responsiblePersonId, followUpPlan }) {
    const inProgress = [...this.treatments.values()].some(
      (t) => t.patientId === patientId && t.status === "in_progress",
    );
    if (inProgress) throw new DomainError("TREATMENT_IN_PROGRESS", "治疗进行中不能按退出处理，应走医疗应急流程");
    this.#cancelBooking(patientId);
    this.patients.get(patientId).status = "withdrawn";
    const result = this.#createReferral({
      patientId,
      reason: "patient_withdrawal",
      responsiblePersonId,
      followUpPlan,
      details: { withdrawalReason: reason },
    });
    return result;
  }

  // 设备故障：尝试改用替代资源重排；无法保证治疗则生成转介，绝不留空。
  reportEquipmentFailure({ deviceId, slotId, responsiblePersonId, followUpPlan, replacementEquipmentIds = [] }) {
    const device = this.devices.get(deviceId);
    if (!device) throw new DomainError("DEVICE_NOT_FOUND", `未知设备：${deviceId}`);
    device.status = "failed";
    device.failedAt = new Date().toISOString();
    this.log("equipment_failed", { deviceId, slotId: slotId ?? null });

    const affected = [];
    for (const slot of this.slots.values()) {
      const booking = slot.booking;
      if (!booking || !booking.equipmentIds.includes(deviceId)) continue;
      if (booking.stage === STAGES.COMPLETED) continue;
      if (CRITICAL_STAGES.has(booking.stage)) {
        // 已进关键阶段：保持资源不动，仅记录故障，由现场医疗处置；这里不撤台。
        affected.push({ patientId: booking.patientId, kept: true });
        continue;
      }
      let moved = false;
      if (replacementEquipmentIds.length) {
        const alt = this.#findAlternativeSlot({
          booking,
          staffIds: [],
          equipmentIds: replacementEquipmentIds,
          consumables: {},
        });
        if (alt) {
          const idx = booking.equipmentIds.indexOf(deviceId);
          booking.equipmentIds.splice(idx, 1, ...replacementEquipmentIds.filter((id) => !booking.equipmentIds.includes(id)));
          this.#moveBooking(slot, alt);
          moved = true;
          affected.push({ patientId: booking.patientId, kept: false, movedTo: alt.id });
        }
      }
      if (!moved) {
        const patientId = booking.patientId;
        this.#cancelBooking(patientId);
        affected.push({ patientId, kept: false, referred: true });
        this.#createReferral({
          patientId,
          reason: "equipment_failure",
          responsiblePersonId,
          followUpPlan,
          details: { deviceId },
        });
      }
    }
    return { deviceId, affected };
  }

  // ---------- 授权交接与任务收尾 ----------

  authorizeHandover({ missionId, toOrgId, authorizedBy }) {
    const mission = this.missions.get(missionId);
    if (!mission) throw new DomainError("MISSION_NOT_FOUND", `未知任务：${missionId}`);
    const org = this.orgs.get(toOrgId);
    if (!org || org.scope !== "local_hospital") {
      throw new DomainError("BAD_HANDOVER_ORG", "交接对象必须是本地医院机构");
    }
    const grant = { missionId, toOrgId, authorizedBy, at: new Date().toISOString() };
    mission.handover = grant;
    this.handoverGrants.push(grant);
    this.log("handover_authorized", grant);
    return grant;
  }

  // 任务结束：每一位未完成治疗的患者都必须落到本地责任人，否则拒绝关闭。
  // plans: { [patientId]: { responsiblePersonId, followUpPlan } }；default 兜底键可选。
  closeMission({ missionId, plans = {} }) {
    const mission = this.missions.get(missionId);
    if (!mission) throw new DomainError("MISSION_NOT_FOUND", `未知任务：${missionId}`);
    if (!mission.handover) throw new DomainError("HANDOVER_REQUIRED", "结束任务前必须先完成授权交接");
    const fallback = plans.default ?? null;

    const unfinished = [];
    for (const patient of this.patients.values()) {
      if (patient.missionId !== missionId) continue;
      const done = [...this.treatments.values()].some((t) => t.patientId === patient.id && t.status === "completed");
      if (done) continue;
      unfinished.push(patient);
      const hasReferral = [...this.referrals.values()].some(
        (r) => r.patientId === patient.id && ["open", "acknowledged"].includes(r.status),
      );
      if (!hasReferral) {
        const plan = plans[patient.id] ?? fallback;
        if (!plan?.responsiblePersonId) {
          throw new DomainError("RESPONSIBLE_REQUIRED", `患者 ${patient.aliases[0]?.value ?? patient.id} 缺少收尾责任人`);
        }
        this.#createReferral({
          patientId: patient.id,
          reason: "mission_close",
          responsiblePersonId: plan.responsiblePersonId,
          followUpPlan: plan.followUpPlan ?? "任务结束后纳入本地医院眼科随访队列，一周内复诊评估",
        });
      }
    }

    // 连续性审计：不允许任何一例无人承接。
    const orphans = this.#findOrphans(missionId);
    if (orphans.length) {
      throw new DomainError("ORPHAN_RECORDS", "存在无责任人的未结记录，任务不可结束", { patientIds: orphans });
    }
    mission.status = "closed";
    mission.closedAt = new Date().toISOString();
    this.log("mission_closed", { missionId, unfinished: unfinished.length });
    return { missionId, closed: true, unfinished: unfinished.length };
  }

  #findOrphans(missionId) {
    const orphans = [];
    for (const patient of this.patients.values()) {
      if (patient.missionId !== missionId) continue;
      const done = [...this.treatments.values()].some((t) => t.patientId === patient.id && t.status === "completed");
      const owned = [...this.referrals.values()].some(
        (r) => r.patientId === patient.id && r.responsiblePersonId && ["open", "acknowledged"].includes(r.status),
      );
      if (!done && !owned) orphans.push(patient.id);
    }
    return orphans;
  }

  // ---------- 别名时间线：返程后仍可还原全链 ----------

  patientTimeline(patientId) {
    const patient = this.patients.get(patientId);
    if (!patient) throw new DomainError("PATIENT_NOT_FOUND", `未知患者：${patientId}`);
    const events = [];

    for (const a of patient.aliases) {
      events.push({ type: "alias_verified", at: a.verifiedAt, alias: a.value, proof: { proofType: a.proofType, proofRef: a.proofRef }, verifiedBy: a.verifiedBy });
    }
    for (const batch of this.batches.values()) {
      if (batch.missionId !== patient.missionId) continue;
      for (const fid of batch.findingIds) {
        const f = this.findings.get(fid);
        if (f.patientId !== patientId) continue;
        events.push({
          type: "offline_finding",
          at: f.capturedAt ?? batch.capturedOfflineAt,
          syncedAt: batch.syncedAt,
          deviceId: batch.deviceId,
          batchClientId: batch.batchClientId,
          summary: f.summary,
          assistVerdict: f.assistVerdict,
          doctorReviewed: f.assistReviewed,
          mergedFromDevices: [...new Set(f.sources.map((s) => s.deviceId))],
        });
      }
    }
    for (const d of this.decisions.filter((x) => x.patientId === patientId)) {
      events.push({ type: "doctor_decision", at: d.at, reviewerId: d.reviewerId, decision: d.decision, note: d.note });
    }
    for (const c of this.consents.values()) {
      if (c.patientId !== patientId) continue;
      events.push({ type: "consent", at: c.signedAt, languageVersion: c.languageVersion, translatedFrom: c.translatedFrom, witnessId: c.witnessId });
    }
    for (const slot of this.slots.values()) {
      const b = slot.booking;
      if (!b || b.patientId !== patientId) continue;
      events.push({
        type: "resource_lock",
        at: slot.date,
        roomId: slot.roomId,
        slot: `${slot.date}#${slot.index}`,
        stage: b.stage,
        staffIds: b.staffIds,
        equipmentIds: b.equipmentIds,
        greenChannel: b.greenChannel,
      });
      if (b.treatmentId) {
        const t = this.treatments.get(b.treatmentId);
        events.push({ type: "treatment", at: t.startedAt, procedure: t.procedure, status: t.status, completedAt: t.completedAt });
      }
    }
    // 已被挤走/取消的排程也从审计日志补入，保证链条不断。
    for (const r of this.referrals.values()) {
      if (r.patientId !== patientId) continue;
      events.push({
        type: "referral",
        at: r.createdAt,
        reason: r.reason,
        responsiblePersonId: r.responsiblePersonId,
        followUpPlan: r.followUpPlan,
        status: r.status,
      });
    }
    events.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    return { patientId, missionId: patient.missionId, aliases: patient.aliases.map((a) => a.value), status: patient.status, events };
  }

  timelineByAlias(missionId, alias) {
    const patient = this.resolveByAlias(missionId, alias);
    if (!patient) throw new DomainError("ALIAS_NOT_FOUND", `任务中找不到别名：${alias}`);
    return this.patientTimeline(patient.id);
  }
}

export { STAGES, CRITICAL_STAGES };
