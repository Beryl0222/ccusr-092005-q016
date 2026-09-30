// 别名时间线还原与连续性核查：返程后确认没有无人承接的记录。

export function chainPhases() {
  return ["alias_verified", "offline_finding", "doctor_decision", "resource_lock", "treatment", "consent", "referral"];
}

// 从别名还原：筛查 → 人工决定 → 治疗或转介 → 后续负责人。
export function restoreByAlias(app, missionId, alias) {
  const timeline = app.timelineByAlias(missionId, alias);
  const has = (type) => timeline.events.some((e) => e.type === type);

  const referral = timeline.events
    .filter((e) => e.type === "referral")
    .sort((a, b) => b.at.localeCompare(a.at))[0];
  const treatment = timeline.events
    .filter((e) => e.type === "treatment")
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];

  let endpoint;
  if (treatment?.status === "completed") endpoint = { kind: "treatment_completed" };
  else if (treatment) endpoint = { kind: "treatment_open", status: treatment.status };
  else if (referral) endpoint = { kind: "referral", reason: referral.reason, responsiblePersonId: referral.responsiblePersonId };
  else endpoint = { kind: "unresolved" };

  return {
    alias: timeline.aliases[0],
    aliases: timeline.aliases,
    patientId: timeline.patientId,
    status: timeline.status,
    chain: {
      screened: has("alias_verified") && has("offline_finding"),
      humanDecision: has("doctor_decision"),
      endpoint,
      hasResponsiblePerson: Boolean(treatment?.status === "completed" || referral?.responsiblePersonId),
    },
    events: timeline.events,
  };
}

// 全任务连续性核查：每位患者都以“完成治疗”或“有责任人的转介”收尾。
export function continuityAudit(app, missionId) {
  const lines = [];
  for (const patient of app.patients.values()) {
    if (patient.missionId !== missionId) continue;
    const restored = restoreByAlias(app, missionId, patient.aliases[0].value);
    lines.push(restored);
  }
  return {
    total: lines.length,
    covered: lines.filter((l) => l.chain.hasResponsiblePerson).length,
    orphans: lines.filter((l) => !l.chain.hasResponsiblePerson).map((l) => l.patientId),
    lines,
  };
}
