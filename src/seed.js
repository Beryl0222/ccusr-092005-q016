import { readFile } from "node:fs/promises";

/**
 * 读取并校验领域基线资料。
 * 返回 { project, records, byKind, byId }，records 保持扁平数组以兼容旧调用。
 */
export async function loadSeed(path = "fixtures/seed.json") {
  const data = JSON.parse(await readFile(path, "utf8"));
  if (!data.project || !Array.isArray(data.records) || data.records.length === 0) {
    throw new Error("领域样例缺少项目名称或记录");
  }
  if (!data.records.every((r) => r.id && r.kind)) {
    throw new Error("领域样例存在缺少 id 或 kind 的记录");
  }

  const ids = new Set();
  for (const r of data.records) {
    if (ids.has(r.id)) throw new Error(`领域样例标识重复: ${r.id}`);
    ids.add(r.id);
  }

  const byKind = {};
  const byId = {};
  for (const r of data.records) {
    (byKind[r.kind] ??= []).push(r);
    byId[r.id] = r;
  }
  return { ...data, byKind, byId };
}
