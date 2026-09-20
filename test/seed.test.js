import assert from "node:assert/strict";
import test from "node:test";

import { loadSeed } from "../src/seed.js";

test("领域样例包含稳定标识", async () => {
  const data = await loadSeed();
  assert.ok(data.records.every((record) => record.id));
});
