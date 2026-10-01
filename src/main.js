import { createServer } from "node:http";
import { resolve } from "node:path";
import { access, readFile } from "node:fs/promises";
import { loadSeed } from "./seed.js";
import { MissionBackend } from "./backend.js";
import { createStore, atomicJsonFile } from "./store.js";
import { createHandler } from "./server.js";

/**
 * 启动流动任务协同后端。
 * 环境变量：
 *   PORT            监听端口（默认 8787）
 *   SEED_PATH       领域资料路径（默认 fixtures/seed.json）
 *   STATE_FILE      状态持久化文件；不设则仅内存运行（适合测试/演示）
 */
export async function createApp({ seedPath = process.env.SEED_PATH ?? "fixtures/seed.json", stateFile = process.env.STATE_FILE ?? null } = {}) {
  const seed = await loadSeed(resolve(seedPath));
  const store = createStore();
  const backend = new MissionBackend(seed, { store });

  if (stateFile) {
    store.onPersist(atomicJsonFile(resolve(stateFile)));
    try {
      await access(resolve(stateFile));
      const snapshot = JSON.parse(await readFile(resolve(stateFile), "utf8"));
      store.hydrate(snapshot);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      // 首次运行：无状态文件，正常冷启动
    }
  }

  const handler = createHandler(backend);
  return { backend, handler };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { handler } = await createApp();
  const port = Number(process.env.PORT ?? 8787);
  createServer(handler).listen(port, () => {
    console.log(`流动眼科协同后端已启动: http://localhost:${port}`);
  });
}
