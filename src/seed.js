import { readFile } from "node:fs/promises";

export async function loadSeed(path = "fixtures/seed.json") {
  const data = JSON.parse(await readFile(path, "utf8"));
  if (!data.project || !Array.isArray(data.records) || data.records.length === 0) {
    throw new Error("领域样例缺少项目名称或记录");
  }
  return data;
}
