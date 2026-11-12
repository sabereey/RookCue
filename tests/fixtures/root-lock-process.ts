import { appendFile } from "node:fs/promises";

import { withLocalRootLock } from "../../src/storage/root-lock.js";

const [root, logPath, id, holdMs = "100", timeoutMs] = process.argv.slice(2);
if (!root || !logPath || !id) {
  throw new Error("root, logPath, and id are required");
}

await withLocalRootLock(
  root,
  async () => {
    await appendFile(logPath, `enter:${id}\n`, "utf8");
    await new Promise((resolve) => setTimeout(resolve, Number(holdMs)));
    await appendFile(logPath, `exit:${id}\n`, "utf8");
  },
  timeoutMs === undefined ? undefined : { timeoutMs: Number(timeoutMs) },
);
