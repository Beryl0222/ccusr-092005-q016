import { randomUUID } from "node:crypto";
import { createStore } from "./store.js";
import { AuthzError, ConflictError, NotFoundError, StateError, ValidationError } from "./errors.js";

const now = () => new Date().toISOString();

/** 可进入治疗路径的医生复核结论。 */
const CANDIDATE_DECISIONS = new Set(["eligible", "green_channel"]);
/** 患者已进入、不得被绿色通道挤占的关键阶段。 */
const PROTECTED_PHASES = new Set(["scheduled", "preop", "in_surgery", "treated"]);
/** 需要生成转介才能闭环退出的结局。 */
const EXIT_OUTCOMES = new Set(["withdrawn", "equipment_failure", "mission_end"]);

const normalizeAlias = (s) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

export class MissionBackend {
  constructor(seed, { store = createStore(), clock = now } = {}) {
    this.seed = seed;
    this.store = store;
    this.now = clock;
    for (const r of seed.records) {
      if (r.kind === "mission") {
        this.store.state.missions[r.id] = {
          id: r.id,
          status: r.status ?? "active",
          name: r.name,
          local_hospital_id: r.local_hospital_id,
          started_at: null,
          closed_at: null,
          close_summary: null,
        };
      }
    }
  }

  get state() {
    return this.store.state;
  }

  // ───────────────────────── 基础查询与审计 ─────────────────────────

  _rec(id) {
    const r = this.seed.byId[id];
    if (!r) throw new NotFoundError(`资源不存在: ${id}`);
    return r;
  }

  _member(memberId) {
    const r = this._rec(memberId);
    if (r.kind !== "member") throw new NotFoundError(`不是成员: ${memberId}`);
    return r;
  }

  _mission(missionId) {
    const m = this.state.missions[missionId];
    if (!m) throw new NotFoundError(`任务不存在: ${missionId}`);
    return m;
  }

  _patient(patientId) {
    const p = this.state.patients[patientId];
    if (!p) throw new NotFoundError(`患者不存在: ${patientId}`);
    return p;
  }

  _activeMission(missionId) {
    const m = this._mission(missionId);
    if (m.status !== "active") throw new StateError(`任务已关闭，不能再变更: ${missionId}`, "MISSION_CLOSED");
    return m;
  }

  _audit(missionId, type, actorId, details = {}) {
    this.state.audit.push({ id: randomUUID(), at: this.now(), missionId, type, actorId, details });
  }

  /**
   * 访问控制：
   * - 中方成员仅能访问被分配到的任务；
   * - 本地医院成员在任务交接授权后可继续查看；任务进行中可作为任务成员参与；
   * - 其他任务（mission_ids 不含本任务）一律拒绝。
   */
  _authorize(missionId, memberId, { write = false } = {}) {
    const member = this._member(memberId);
    const assigned = Array.isArray(member.mission_ids) && member.mission_ids.includes(missionId);
    const mission = this._mission(missionId);
    const handed =
      mission.status === "closed" &&
      mission.close_summary?.handover_ids?.some(
        (hId) => this.state.handovers[hId]?.hospital_id === member.hospital_id,
      );

    if (member.org === "chinese_team") {
      if (!assigned) throw new AuthzError("中方成员仅能访问被分配的任务", "OUT_OF_MISSION_SCOPE");
      if (write && mission.status === "closed") {
        throw new AuthzError("任务关闭后中方成员不能再变更数据", "MISSION_CLOSED");
      }
      return { member, mission, role: "mission_member" };
    }

    if (member.org === "local_hospital") {
      if (write && !assigned) {
        throw new AuthzError("该医院成员未参与此任务，不能写入", "OUT_OF_MISSION_SCOPE");
      }
      if (!assigned && !(write === false && handed)) {
        throw new AuthzError("未获交接授权，不能访问该任务", "NO_HANDOVER");
      }
      if (write && mission.status === "closed") {
        throw new AuthzError("任务关闭后数据只读", "MISSION_CLOSED");
      }
      return { member, mission, role: handed ? "handover_receiver" : "mission_member" };
    }

    throw new AuthzError("未知机构，拒绝访问", "UNKNOWN_ORG");
  }

  _requireRole(memberId, roles) {
    const m = this._member(memberId);
    const ok = m.roles.some((r) => roles.includes(r));
    if (!ok) throw new AuthzError(`成员 ${memberId} 缺少角色: ${roles.join("/")}`, "ROLE_DENIED");
    return m;
  }

  // ───────────────────────── 筛查批次与患者别名 ─────────────────────────

  /**
   * 患者以当地可核验别名进入筛查批次。
   * 同一任务内 local_name 规范化后 + 村落命中已有患者时不新建档案，
   * 只追加一次接触记录，保证离线多点重复登记不产生第二例。
   */
  registerScreening({ missionId, batchId, localName, locale = "fj", village = "", demographics = {}, verifierId, registeredBy, deviceId }) {
    this._activeMission(missionId);
    this._authorize(missionId, registeredBy, { write: true });
    const verifier = this._member(verifierId);
    if (deviceId) this._rec(deviceId);
    if (!localName || !localName.trim()) throw new ValidationError("localName 不能为空");

    const key = `${missionId}|${normalizeAlias(localName)}|${normalizeAlias(village)}`;
    let patient = this.store.aliasIndex.get(key)
      ? this.state.patients[this.store.aliasIndex.get(key)]
      : null;

    const batch = this._ensureBatch(missionId, batchId, registeredBy);

    if (!patient) {
      patient = {
        id: `pat-${randomUUID()}`,
        missionId,
        aliases: [{ local_name: localName.trim(), locale, village: village.trim(), verified_by: verifierId, verified_at: this.now() }],
        demographics,
        status: "screened",
        contacts: [],
        image_ids: [],
        review_id: null,
        consent_ids: [],
        slot_ids: [],
        treatment_id: null,
        referral_id: null,
        created_by: registeredBy,
        created_at: this.now(),
      };
      this.state.patients[patient.id] = patient;
      this.store.aliasIndex.set(key, patient.id);
      this._audit(missionId, "patient.created", registeredBy, { patientId: patient.id, alias: localName, verifierId });
    } else {
      if (!patient.aliases.some((a) => a.locale === locale && normalizeAlias(a.local_name) === normalizeAlias(localName))) {
        patient.aliases.push({ local_name: localName.trim(), locale, village: village.trim(), verified_by: verifierId, verified_at: this.now() });
      }
      this._audit(missionId, "patient.alias_reuse", registeredBy, { patientId: patient.id, alias: localName });
    }

    const contact = {
      id: `contact-${randomUUID()}`,
      at: this.now(),
      batch_id: batchId,
      device_id: deviceId ?? null,
      registered_by: registeredBy,
      verifier_id: verifierId,
      note: demographics.note ?? null,
    };
    patient.contacts.push(contact);
    batch.patient_ids.push(patient.id);
    batch.patient_ids = [...new Set(batch.patient_ids)];
    this._audit(missionId, "screening.contact", registeredBy, { patientId: patient.id, batchId });
    return { patientId: patient.id, contact, batchId: batch.id, reused: patient.contacts.length > 1 };
  }

  _ensureBatch(missionId, batchId, actorId) {
    const existing = this.state.batches[batchId];
    if (existing) {
      if (existing.missionId !== missionId) {
        throw new ConflictError(`批次 ${batchId} 已属于另一任务`, "BATCH_MISSION_MISMATCH");
      }
      return existing;
    }
    const batch = {
      id: batchId,
      missionId,
      opened_at: this.now(),
      opened_by: actorId,
      patient_ids: [],
      device_ids: [],
    };
    this.state.batches[batchId] = batch;
    return batch;
  }

  // ───────────────────────── 离线图像摘要同步与去重合并 ─────────────────────────

  /**
   * 便携设备离线生成图像摘要，联网后同步。
   * - 幂等：clientSyncId 重复提交返回首条，不重复入库；
   * - 内容去重：同设备同 contentHash 合并到已有图像（保留多批次来源）；
   * - 辅助判断（assistSuggestion）仅为建议，不改变患者状态；
   * 只有医生复核才可进入候选治疗路径。
   */
  syncImageSummary(input) {
    const { missionId, batchId, deviceId, patientId, contentHash, capturedAt, assistSuggestion = null, clientSyncId, actorId } = input;
    this._activeMission(missionId);
    this._authorize(missionId, actorId, { write: true });
    this._rec(deviceId);
    const patient = this._patient(patientId);
    if (patient.missionId !== missionId) throw new ValidationError("患者不属于该任务");
    if (!contentHash) throw new ValidationError("contentHash 不能为空");
    this._ensureBatch(missionId, batchId, actorId);

    const idemKey = `sync|${missionId}|${deviceId}|${clientSyncId}`;
    // 内容去重以“任务+患者+内容哈希”为键：同一患者在不同设备/批次重传的同一图像合并
    const hashKey = `${missionId}|${patientId}|${contentHash}`;

    const exec = () => {
      let imageId;
      let merged = false;

      if (this.store.imageHashIndex.has(hashKey)) {
        imageId = this.store.imageHashIndex.get(hashKey);
        const image = this.state.images[imageId];
        image.sources.push({ batch_id: batchId, client_sync_id: clientSyncId, received_at: this.now() });
        image.sync_count += 1;
        merged = true;
        this._audit(missionId, "image.merged", actorId, { imageId, patientId, batchId, contentHash });
      } else {
        imageId = `img-${randomUUID()}`;
        this.state.images[imageId] = {
          id: imageId,
          missionId,
          patient_id: patientId,
          device_id: deviceId,
          content_hash: contentHash,
          captured_at: capturedAt ?? this.now(),
          received_at: this.now(),
          assist_suggestion: assistSuggestion,
          assist_status: "advisory_only",
          reviewed: false,
          sources: [{ batch_id: batchId, client_sync_id: clientSyncId, received_at: this.now() }],
          sync_count: 1,
        };
        patient.image_ids.push(imageId);
        this.store.imageHashIndex.set(hashKey, imageId);
        const batch = this.state.batches[batchId];
        batch.device_ids.push(deviceId);
        batch.device_ids = [...new Set(batch.device_ids)];
        this._audit(missionId, "image.ingested", actorId, { imageId, patientId, batchId, contentHash });
      }
      return { imageId, merged, contentHash };
    };

    const result = this.store.runIdempotent(idemKey, exec);
    return result;
  }

  // ───────────────────────── 医生复核（进入候选治疗路径的唯一闸门） ─────────────────────────

  /**
   * 医生人工复核。decision:
   *  - eligible：候选治疗路径
   *  - green_channel：绿色通道候选（需理由）
   *  - observe / reject：不进入治疗
   * 图像/设备的辅助判断不能触发候选，必须由医生显式复核。
   */
  reviewPatient({ missionId, patientId, doctorId, decision, reason = "", findings = {} }) {
    this._activeMission(missionId);
    this._authorize(missionId, doctorId, { write: true });
    this._requireRole(doctorId, ["doctor"]);
    const patient = this._patient(patientId);
    if (patient.missionId !== missionId) throw new ValidationError("患者不属于该任务");
    if (!["eligible", "green_channel", "observe", "reject"].includes(decision)) {
      throw new ValidationError("未知复核结论");
    }
    if (decision === "green_channel" && !reason.trim()) {
      throw new ValidationError("绿色通道必须记录理由");
    }
    if (patient.image_ids.length === 0) {
      throw new StateError("缺少已同步的图像摘要，不能复核", "NO_IMAGE");
    }

    const priorReviewId = patient.review_id;
    if (priorReviewId) {
      const prior = this.state.reviews[priorReviewId];
      // 已入候选路径的决定不可重复做出；observe/reject 后病情变化可由医生重新复核（留痕替代关系）
      if (CANDIDATE_DECISIONS.has(prior.decision)) {
        throw new ConflictError("该患者已完成医生复核，不能重复决定", "ALREADY_REVIEWED");
      }
      if (patient.referral_id) {
        throw new ConflictError("患者已有转介记录，需先由本地团队重新评估", "ALREADY_REFERRED");
      }
    }

    const review = {
      id: `rev-${randomUUID()}`,
      missionId,
      patient_id: patientId,
      doctor_id: doctorId,
      decision,
      reason,
      findings,
      green_channel: decision === "green_channel",
      supersedes: priorReviewId ?? null,
      at: this.now(),
    };
    this.state.reviews[review.id] = review;
    patient.review_id = review.id;
    for (const imgId of patient.image_ids) this.state.images[imgId].reviewed = true;

    if (CANDIDATE_DECISIONS.has(decision)) {
      patient.status = decision === "green_channel" ? "green_channel_candidate" : "candidate";
    } else {
      patient.status = `review_${decision}`;
    }
    this._audit(missionId, "patient.reviewed", doctorId, { patientId, decision, reason });
    return review;
  }

  // ───────────────────────── 知情同意（语言版本 + 见证人） ─────────────────────────

  recordConsent({ missionId, patientId, memberId, languageVersion, witnessId, signatureType = "mark", textVersion }) {
    this._activeMission(missionId);
    this._authorize(missionId, memberId, { write: true });
    const patient = this._patient(patientId);
    if (!languageVersion || !languageVersion.trim()) throw new ValidationError("必须保存知情同意语言版本");
    if (!witnessId) throw new ValidationError("知情同意必须记录见证人");
    const witness = this._member(witnessId);
    if (witness.id === memberId) throw new ValidationError("见证人不能是登记人本人");
    if (!patient.review_id || !CANDIDATE_DECISIONS.has(this.state.reviews[patient.review_id].decision)) {
      throw new StateError("未经医生复核为候选，不能签署治疗知情同意", "NOT_CANDIDATE");
    }

    const consent = {
      id: `con-${randomUUID()}`,
      missionId,
      patient_id: patientId,
      language_version: languageVersion.trim(),
      text_version: textVersion ?? `consent-v1-${languageVersion.trim()}`,
      signature_type: signatureType, // 文盲/低识字患者可用按指印+见证
      witness_id: witnessId,
      recorded_by: memberId,
      at: this.now(),
    };
    this.state.consents[consent.id] = consent;
    patient.consent_ids.push(consent.id);
    this._audit(missionId, "consent.recorded", memberId, { patientId, consentId: consent.id, languageVersion, witnessId });
    return consent;
  }

  // ───────────────────────── 资源：时段锁定、冲突检测、耗材 ─────────────────────────

  _overlap(aStart, aEnd, bStart, bEnd) {
    return aStart < bEnd && bStart < aEnd;
  }

  _resourceSlots(resourceId) {
    return Object.values(this.state.slots).filter(
      (s) => s.status === "held" && (s.resource_ids.includes(resourceId) || s.staff_ids.includes(resourceId)),
    );
  }

  _checkConflict(resourceIds, startAt, endAt, ignoreSlotId = null) {
    for (const rid of resourceIds) {
      for (const s of this._resourceSlots(rid)) {
        if (s.id === ignoreSlotId) continue;
        if (this._overlap(startAt, endAt, s.start_at, s.end_at)) {
          throw new ConflictError(`资源 ${rid} 在 ${s.start_at}~${s.end_at} 已被锁定`, "RESOURCE_CONFLICT", {
            resourceId: rid,
            conflictingSlotId: s.id,
            patientId: s.patient_id,
          });
        }
      }
    }
  }

  _holdConsumables(consumables, slotId) {
    const planned = [];
    // 先整体校验，任一耗材不足则整单拒绝，避免部分预占泄漏
    for (const [cid, qty] of Object.entries(consumables)) {
      const rec = this._rec(cid);
      if (rec.kind !== "resource" || rec.type !== "consumable") throw new ValidationError(`${cid} 不是耗材`);
      if (!Number.isInteger(qty) || qty <= 0) throw new ValidationError(`${cid} 耗材数量必须为正整数`);
      const usage = this.state.consumptions[cid] ?? { used: 0, holds: {} };
      const heldTotal = Object.values(usage.holds).reduce((sum, q) => sum + q, 0);
      if (rec.stock - usage.used - heldTotal < qty) {
        throw new ConflictError(`耗材 ${cid} 库存不足：需要 ${qty}，可用 ${rec.stock - usage.used - heldTotal}`, "CONSUMABLE_SHORTAGE");
      }
      planned.push([cid, qty]);
    }
    for (const [cid, qty] of planned) {
      const usage = this.state.consumptions[cid] ?? { used: 0, holds: {} };
      usage.holds[slotId] = qty;
      this.state.consumptions[cid] = usage;
    }
  }

  _releaseConsumableHolds(slotId) {
    for (const [cid, usage] of Object.entries(this.state.consumptions)) {
      if (usage.holds[slotId] !== undefined) {
        delete usage.holds[slotId];
      }
    }
  }

  _commitConsumables(slot) {
    for (const [cid, qty] of Object.entries(slot.consumables)) {
      const usage = this.state.consumptions[cid];
      delete usage.holds[slot.id];
      usage.used += qty;
    }
  }

  consumableAvailability(resourceId) {
    const rec = this._rec(resourceId);
    if (rec.kind !== "resource" || rec.type !== "consumable") throw new ValidationError("不是耗材");
    const usage = this.state.consumptions[resourceId] ?? { used: 0, holds: {} };
    const held = Object.values(usage.holds).reduce((a, b) => a + b, 0);
    return { resourceId, stock: rec.stock, used: usage.used, held, available: rec.stock - usage.used - held };
  }

  /**
   * 锁定手术间、设备、人员和耗材到时段。
   * 人员按 memberId 作为可锁定资源参与冲突检测；耗材做库存预占。
   */
  scheduleSlot({ missionId, patientId, memberId, startAt, endAt, resourceIds = [], staffIds = [], consumables = {}, note = "" }) {
    this._activeMission(missionId);
    this._authorize(missionId, memberId, { write: true });
    this._requireRole(memberId, ["coordinator", "mission_lead", "doctor"]);
    const patient = this._patient(patientId);
    if (!patient.review_id) throw new StateError("患者未经医生复核，不能排程", "NOT_REVIEWED");
    const review = this.state.reviews[patient.review_id];
    if (!CANDIDATE_DECISIONS.has(review.decision)) throw new StateError("复核结论不支持治疗，不能排程", "NOT_CANDIDATE");
    if (patient.treatment_id) throw new ConflictError("患者已完成治疗，不能再排程", "ALREADY_TREATED");
    if (patient.consent_ids.length === 0) throw new StateError("缺少知情同意，不能排程", "NO_CONSENT");
    if (!(startAt < endAt)) throw new ValidationError("时段必须满足 startAt < endAt");
    for (const sid of staffIds) this._member(sid);

    // 关键阶段保护：已排程/术前/术中/已治疗的患者不能被后来者（含绿色通道）抢占同一资源
    const allLockables = [...resourceIds, ...staffIds];
    this._checkConflict(allLockables, startAt, endAt);

    const slot = {
      id: `slot-${randomUUID()}`,
      missionId,
      patient_id: patientId,
      resource_ids: [...resourceIds],
      staff_ids: [...staffIds],
      consumables: { ...consumables },
      start_at: startAt,
      end_at: endAt,
      priority: review.green_channel ? "green_channel" : "normal",
      status: "held",
      phase: "scheduled",
      note,
      created_by: memberId,
      created_at: this.now(),
    };
    this._holdConsumables(consumables, slot.id);
    this.state.slots[slot.id] = slot;
    patient.slot_ids.push(slot.id);
    patient.status = "scheduled";
    this._audit(missionId, "slot.locked", memberId, { patientId, slotId: slot.id, resourceIds, staffIds, startAt, endAt });
    return slot;
  }

  // ───────────────────────── 临时加急（绿色通道） ─────────────────────────

  /**
   * 临时加急：在已有排程上插入加急时段，必须：
   *  - 患者为医生复核的绿色通道候选且理由已记录（review.reason）；
   *  - 提供加急理由；
   *  - 不能挤占任何已进入关键阶段（scheduled/preop/in_surgery/treated）患者锁定的资源；
   *    冲突时直接拒绝（不自动踢人），由协调员改时段或换资源。
   */
  expediteSlot({ missionId, patientId, coordinatorId, startAt, endAt, resourceIds = [], staffIds = [], consumables = {}, reason }) {
    this._activeMission(missionId);
    this._authorize(missionId, coordinatorId, { write: true });
    this._requireRole(coordinatorId, ["coordinator", "mission_lead"]);
    if (!reason || !reason.trim()) throw new ValidationError("加急必须记录理由");
    const patient = this._patient(patientId);
    if (!patient.review_id) throw new StateError("未经医生复核", "NOT_REVIEWED");
    const review = this.state.reviews[patient.review_id];
    if (review.decision !== "green_channel") throw new ConflictError("该患者不是绿色通道候选，不能加急", "NOT_GREEN_CHANNEL");
    if (patient.consent_ids.length === 0) throw new StateError("缺少知情同意", "NO_CONSENT");

    // 冲突检测中显式校验受保护患者
    for (const rid of [...resourceIds, ...staffIds]) {
      for (const s of this._resourceSlots(rid)) {
        if (this._overlap(startAt, endAt, s.start_at, s.end_at)) {
          const holder = this.state.patients[s.patient_id];
          if (PROTECTED_PHASES.has(s.phase) || PROTECTED_PHASES.has(holder?.status)) {
            throw new ConflictError(
              `加急被拒绝：资源 ${rid} 已用于已进入关键阶段（${s.phase}）的患者 ${s.patient_id}`,
              "PROTECTED_PATIENT",
              { resourceId: rid, blockingSlotId: s.id, blockingPatientId: s.patient_id, phase: s.phase },
            );
          }
        }
      }
    }

    const slot = {
      id: `slot-${randomUUID()}`,
      missionId,
      patient_id: patientId,
      resource_ids: [...resourceIds],
      staff_ids: [...staffIds],
      consumables: { ...consumables },
      start_at: startAt,
      end_at: endAt,
      priority: "green_channel",
      expedite: { reason: reason.trim(), requested_by: coordinatorId, review_reason: review.reason, at: this.now() },
      status: "held",
      phase: "scheduled",
      created_by: coordinatorId,
      created_at: this.now(),
    };
    this._holdConsumables(consumables, slot.id);
    this.state.slots[slot.id] = slot;
    patient.slot_ids.push(slot.id);
    patient.status = "scheduled";
    this._audit(missionId, "slot.expedited", coordinatorId, { patientId, slotId: slot.id, reason, reviewReason: review.reason });
    return slot;
  }

  /** 推进术前/术中阶段（关键阶段标记的一部分）。 */
  advancePhase({ missionId, slotId, memberId, phase }) {
    this._activeMission(missionId);
    this._authorize(missionId, memberId, { write: true });
    if (!["preop", "in_surgery"].includes(phase)) throw new ValidationError("非法阶段");
    const slot = this.state.slots[slotId];
    if (!slot || slot.missionId !== missionId) throw new NotFoundError("时段不存在");
    if (slot.status !== "held") throw new StateError("时段不再有效", "SLOT_NOT_HELD");
    slot.phase = phase;
    const patient = this.state.patients[slot.patient_id];
    patient.status = phase;
    this._audit(missionId, "slot.phase", memberId, { slotId, phase });
    return slot;
  }

  // ───────────────────────── 治疗（每例患者至多一条，重复同步幂等） ─────────────────────────

  /**
   * 记录治疗完成。重复提交（网络重试/双端重复同步）返回已有治疗，
   * 绝不创建第二例治疗；耗材在首次提交时扣减。
   */
  completeTreatment({ missionId, patientId, memberId, procedure, performedAt = this.now(), clientTxId, details = {} }) {
    this._activeMission(missionId);
    this._authorize(missionId, memberId, { write: true });
    this._requireRole(memberId, ["doctor"]);
    const patient = this._patient(patientId);
    if (!patient.review_id || !CANDIDATE_DECISIONS.has(this.state.reviews[patient.review_id].decision)) {
      throw new StateError("患者未进入候选治疗路径", "NOT_CANDIDATE");
    }

    // 第一层防线：业务唯一性（无论是否带 clientTxId 都生效）
    if (patient.treatment_id) {
      return { ...this.state.treatments[patient.treatment_id], replayed: true, duplicate: true };
    }

    const idemKey = `treatment|${missionId}|${patientId}|${clientTxId ?? "default"}`;
    const result = this.store.runIdempotent(idemKey, () => {
      const activeSlot = patient.slot_ids
        .map((id) => this.state.slots[id])
        .find((s) => s.status === "held");
      if (!activeSlot) throw new StateError("没有已锁定的治疗时段", "NO_SLOT");

      const treatment = {
        id: `tx-${randomUUID()}`,
        missionId,
        patient_id: patientId,
        slot_id: activeSlot.id,
        procedure,
        performed_by: memberId,
        performed_at: performedAt,
        details,
        at: this.now(),
      };
      this.state.treatments[treatment.id] = treatment;
      patient.treatment_id = treatment.id;
      patient.status = "treated";
      activeSlot.status = "completed";
      activeSlot.phase = "treated";
      this._commitConsumables(activeSlot);
      this._audit(missionId, "treatment.completed", memberId, { patientId, treatmentId: treatment.id, slotId: activeSlot.id });
      return treatment;
    });
    return { ...result, duplicate: false };
  }

  // ───────────────────────── 退出 / 设备故障 / 任务结束：转介与责任人 ─────────────────────────

  /**
   * 患者退出或因设备故障无法治疗时，必须生成明确转介：
   * 记录 reason、目的地（本地医院/外院）、责任人（followUpOwnerId）与时限。
   */
  createReferral({ missionId, patientId, memberId, outcome, reason, destinationHospitalId, followUpOwnerId, followUpDueAt, notes = "" }) {
    this._activeMission(missionId);
    this._authorize(missionId, memberId, { write: true });
    const patient = this._patient(patientId);
    if (!EXIT_OUTCOMES.has(outcome)) throw new ValidationError("outcome 必须是 withdrawn/equipment_failure/mission_end 之一");
    if (!reason || !reason.trim()) throw new ValidationError("转介必须记录原因");
    if (!followUpOwnerId) throw new ValidationError("转介必须指定后续责任人");
    const owner = this._member(followUpOwnerId);
    const dest = destinationHospitalId ? this._rec(destinationHospitalId) : this._rec(this._mission(missionId).local_hospital_id);
    if (dest.kind !== "local_hospital") throw new ValidationError("转介目的地必须是医院");
    if (patient.treatment_id) throw new ConflictError("患者已完成治疗，不需要退出转介", "ALREADY_TREATED");
    if (patient.referral_id) throw new ConflictError("患者已有转介记录，不能重复创建", "ALREADY_REFERRED");

    // 释放该患者未完成的资源锁定与耗材预占
    const releasedSlots = [];
    for (const sid of patient.slot_ids) {
      const slot = this.state.slots[sid];
      if (slot.status === "held") {
        slot.status = "released";
        slot.released_reason = outcome;
        slot.released_at = this.now();
        this._releaseConsumableHolds(slot.id);
        releasedSlots.push(slot.id);
      }
    }

    const referral = {
      id: `ref-${randomUUID()}`,
      missionId,
      patient_id: patientId,
      outcome,
      reason: reason.trim(),
      destination_hospital_id: dest.id,
      follow_up_owner_id: owner.id,
      follow_up_owner_name: owner.name,
      follow_up_due_at: followUpDueAt ?? null,
      notes,
      released_slot_ids: releasedSlots,
      created_by: memberId,
      created_at: this.now(),
      status: "open",
      acknowledged_at: null,
    };
    this.state.referrals[referral.id] = referral;
    patient.referral_id = referral.id;
    patient.status = outcome === "withdrawn" ? "withdrawn_referred" : "pending_followup";
    this._audit(missionId, "referral.created", memberId, {
      patientId, referralId: referral.id, outcome, ownerId: owner.id, releasedSlots,
    });
    return referral;
  }

  /** 设备故障：登记故障并为受影响患者批量生成设备故障转介。 */
  reportEquipmentFailure({ missionId, equipmentId, memberId, reason, affectedPatientIds = [], followUpOwnerId, followUpDueAt }) {
    this._activeMission(missionId);
    this._authorize(missionId, memberId, { write: true });
    const equipment = this._rec(equipmentId);
    if (equipment.kind !== "resource" || equipment.type !== "equipment") throw new ValidationError("目标不是设备");
    if (!reason || !reason.trim()) throw new ValidationError("设备故障必须记录原因");

    const event = {
      id: `fault-${randomUUID()}`,
      missionId,
      equipment_id: equipmentId,
      reason: reason.trim(),
      affected_patient_ids: [...affectedPatientIds],
      reported_by: memberId,
      at: this.now(),
    };
    this.state.equipment_faults.push(event);
    this._audit(missionId, "equipment.failed", memberId, { equipmentId, reason, affectedPatientIds });

    // 找出占用故障设备且尚未治疗的患者；转介时由 createReferral 统一释放其全部未完成时段
    const affectedIds = new Set(affectedPatientIds);
    for (const slot of Object.values(this.state.slots)) {
      if (slot.missionId !== missionId || slot.status !== "held") continue;
      if (slot.resource_ids.includes(equipmentId)) affectedIds.add(slot.patient_id);
    }

    const needsReferral = [...affectedIds].some((pid) => {
      const p = this.state.patients[pid];
      return p && !p.treatment_id && !p.referral_id &&
        p.slot_ids.map((id) => this.state.slots[id])
          .some((s) => s.status === "held" && s.resource_ids.includes(equipmentId));
    });
    if (needsReferral && !followUpOwnerId) {
      throw new ValidationError("设备故障波及未治疗患者时必须指定转介责任人");
    }

    const referrals = [];
    for (const patientId of affectedIds) {
      const patient = this.state.patients[patientId];
      if (!patient || patient.missionId !== missionId || patient.treatment_id || patient.referral_id) continue;
      // 仅当该患者确实有受故障影响的未完成时段时才自动转介
      const affectedSlot = patient.slot_ids
        .map((id) => this.state.slots[id])
        .find((s) => s.status === "held" && s.resource_ids.includes(equipmentId));
      if (!affectedSlot) continue;
      referrals.push(
        this.createReferral({
          missionId,
          patientId,
          memberId,
          outcome: "equipment_failure",
          reason: `设备 ${equipment.name}（${equipmentId}）故障：${reason}`,
          destinationHospitalId: this._mission(missionId).local_hospital_id,
          followUpOwnerId,
          followUpDueAt,
        }),
      );
    }
    event.affected_patient_ids = referrals.map((r) => r.patient_id);
    return { event, referrals };
  }

  // ───────────────────────── 交接授权与任务关闭 ─────────────────────────

  /**
   * 授权本地医院交接：授权后本地医院成员可继续查看该任务全部记录。
   * 中方成员的访问仍限定在任务范围（读），关闭后不能写。
   */
  authorizeHandover({ missionId, hospitalId, memberId, scope = "full" }) {
    this._activeMission(missionId);
    this._authorize(missionId, memberId, { write: true });
    this._requireRole(memberId, ["mission_lead", "coordinator"]);
    const hospital = this._rec(hospitalId);
    if (hospital.kind !== "local_hospital") throw new ValidationError("交接对象必须是本地医院");

    const existing = Object.values(this.state.handovers).find(
      (h) => h.missionId === missionId && h.hospital_id === hospitalId && h.status === "active",
    );
    if (existing) return { ...existing, replayed: true };

    const handover = {
      id: `hand-${randomUUID()}`,
      missionId,
      hospital_id: hospitalId,
      scope,
      authorized_by: memberId,
      authorized_at: this.now(),
      status: "active",
    };
    this.state.handovers[handover.id] = handover;
    this._audit(missionId, "handover.authorized", memberId, { hospitalId, handoverId: handover.id });
    return handover;
  }

  /** 本地医院责任人确认承接某条转介。 */
  acknowledgeReferral({ missionId, referralId, memberId }) {
    const { member } = this._authorize(missionId, memberId, { write: false });
    const referral = this.state.referrals[referralId];
    if (!referral || referral.missionId !== missionId) throw new NotFoundError("转介不存在");
    const mission = this._mission(missionId);
    const handed = mission.close_summary?.handover_ids?.some(
      (hId) => this.state.handovers[hId]?.hospital_id === member.hospital_id,
    );
    if (!(member.mission_ids?.includes(missionId) || handed)) throw new AuthzError("无权承接该转介", "NO_HANDOVER");
    referral.status = "acknowledged";
    referral.acknowledged_at = this.now();
    referral.acknowledged_by = memberId;
    const patient = this.state.patients[referral.patient_id];
    patient.status = "followup_accepted";
    this._audit(missionId, "referral.acknowledged", memberId, { referralId, patientId: referral.patient_id });
    return referral;
  }

  /**
   * 任务结束关闭：
   *  - 所有未完成治疗的患者必须已有明确转介与责任人，否则拒绝关闭（无孤儿）；
   *  - 关闭后只读，中方成员保留任务范围内读权限，本地医院凭交接授权继续查看。
   */
  closeMission({ missionId, memberId }) {
    this._activeMission(missionId);
    this._authorize(missionId, memberId, { write: true });
    this._requireRole(memberId, ["mission_lead", "coordinator"]);

    const handoverIds = Object.values(this.state.handovers)
      .filter((h) => h.missionId === missionId && h.status === "active")
      .map((h) => h.id);
    if (handoverIds.length === 0) {
      throw new StateError("关闭任务前必须先授权本地医院交接", "HANDOVER_REQUIRED");
    }

    const orphaned = [];
    for (const p of Object.values(this.state.patients)) {
      if (p.missionId !== missionId) continue;
      if (p.treatment_id) continue;
      if (!p.referral_id) {
        orphaned.push({ patientId: p.id, status: p.status, alias: p.aliases[0]?.local_name });
      } else {
        const ref = this.state.referrals[p.referral_id];
        if (!ref.follow_up_owner_id) orphaned.push({ patientId: p.id, reason: "missing_owner" });
      }
    }
    if (orphaned.length > 0) {
      throw new ConflictError("存在未完成治疗且无明确转介/责任人的患者，不能关闭任务", "ORPHANED_PATIENTS", { orphaned });
    }

    // 关闭时收口所有残留的未完成时段；此时未治疗患者必然已有转介（其时段已在转介时释放），
    // 这里覆盖的是已治疗患者名下多余的备用锁定，退回耗材预占。
    for (const slot of Object.values(this.state.slots)) {
      if (slot.missionId === missionId && slot.status === "held") {
        slot.status = "released";
        slot.released_reason = "mission_end";
        slot.released_at = this.now();
        this._releaseConsumableHolds(slot.id);
      }
    }

    const mission = this._mission(missionId);
    const patients = Object.values(this.state.patients).filter((p) => p.missionId === missionId);
    mission.status = "closed";
    mission.closed_at = this.now();
    mission.close_summary = {
      handover_ids: handoverIds,
      total_patients: patients.length,
      treated: patients.filter((p) => p.treatment_id).length,
      referred: patients.filter((p) => p.referral_id).length,
      closed_by: memberId,
    };
    this._audit(missionId, "mission.closed", memberId, mission.close_summary);
    return mission;
  }

  // ───────────────────────── 别名还原：筛查 → 决定 → 治疗/转介 → 后续负责人 ─────────────────────────

  /**
   * 从当地别名还原完整链路。
   * 命中方式：任务 + 语言 + 规范化姓名（可加村落）。
   */
  resolveByAlias({ missionId, localName, locale = "fj", village = "", actorId }) {
    this._authorize(missionId, actorId, { write: false });
    const found = Object.values(this.state.patients).filter((p) =>
      p.missionId === missionId &&
      p.aliases.some(
        (a) =>
          a.locale === locale &&
          normalizeAlias(a.local_name) === normalizeAlias(localName) &&
          (!village || normalizeAlias(a.village) === normalizeAlias(village)),
      ),
    );
    return found.map((p) => this.timeline(p.id, actorId));
  }

  timeline(patientId, actorId) {
    const patient = this._patient(patientId);
    if (actorId) this._authorize(patient.missionId, actorId, { write: false });
    const review = patient.review_id ? this.state.reviews[patient.review_id] : null;
    const treatment = patient.treatment_id ? this.state.treatments[patient.treatment_id] : null;
    const referral = patient.referral_id ? this.state.referrals[patient.referral_id] : null;

    const trail = [
      ...patient.contacts.map((c) => ({ at: c.at, stage: "screening", ref: c })),
      ...patient.image_ids.map((id) => ({ at: this.state.images[id].received_at, stage: "image_synced", ref: this.state.images[id] })),
      ...(review ? [{ at: review.at, stage: "physician_decision", ref: review }] : []),
      ...patient.consent_ids.map((id) => ({ at: this.state.consents[id].at, stage: "consent", ref: this.state.consents[id] })),
      ...patient.slot_ids.map((id) => ({ at: this.state.slots[id].created_at, stage: "scheduling", ref: this.state.slots[id] })),
      ...(treatment ? [{ at: treatment.at, stage: "treatment", ref: treatment }] : []),
      ...(referral ? [{ at: referral.created_at, stage: "referral", ref: referral }] : []),
    ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

    return {
      patient: {
        id: patient.id,
        status: patient.status,
        aliases: patient.aliases,
        demographics: patient.demographics,
      },
      trail,
      outcome: treatment
        ? { kind: "treated", treatment_id: treatment.id, procedure: treatment.procedure, performed_by: treatment.performed_by }
        : referral
          ? {
              kind: referral.outcome,
              referral_id: referral.id,
              reason: referral.reason,
              destination_hospital_id: referral.destination_hospital_id,
              follow_up_owner: { id: referral.follow_up_owner_id, name: referral.follow_up_owner_name },
              follow_up_due_at: referral.follow_up_due_at,
              referral_status: referral.status,
            }
          : { kind: "in_progress", status: patient.status },
    };
  }

  /** 闭环校验：返回未完成治疗且无人承接的患者列表（空数组即全部可追溯）。 */
  findOrphans(missionId) {
    return Object.values(this.state.patients)
      .filter((p) => p.missionId === missionId && !p.treatment_id)
      .filter((p) => {
        if (!p.referral_id) return true;
        const ref = this.state.referrals[p.referral_id];
        return !ref.follow_up_owner_id;
      })
      .map((p) => ({ patientId: p.id, alias: p.aliases[0]?.local_name, status: p.status }));
  }

  listAudit(missionId, actorId) {
    if (actorId) this._authorize(missionId, actorId, { write: false });
    return this.state.audit.filter((e) => e.missionId === missionId);
  }
}
