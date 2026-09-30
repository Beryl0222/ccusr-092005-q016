// 从领域资料基线装配可运行环境：任务、设备、人员、耗材，并生成手术时段。
import { readFile } from "node:fs/promises";

import { MissionBackend } from "./backend.js";
import { loadSeed } from "./seed.js";

export async function setupFromSeed(path = "fixtures/seed.json") {
  const data = await loadSeed(path);
  const app = new MissionBackend();
  app.loadSeed(data);

  const days = missionDays(data);
  const slots = [];
  for (const room of app.rooms.values()) {
    for (const date of days) {
      slots.push(...app.createSlots(room.id, date, slotLabels(room.slots_per_day)));
    }
  }
  return { app, data, slots };
}

export function missionDays(data) {
  const mission = data.records.find((r) => r.kind === "mission");
  const start = new Date(`${mission.start_date}T00:00:00Z`);
  const end = new Date(`${mission.end_date}T00:00:00Z`);
  const days = [];
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

function slotLabels(n) {
  const names = ["上午一台", "上午二台", "下午一台", "下午二台"];
  return Array.from({ length: n }, (_, i) => names[i] ?? `时段 ${i + 1}`);
}
