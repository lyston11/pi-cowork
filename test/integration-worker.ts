import { HandoffStore } from "../store.ts";
import { IntegrationQueue } from "../integration-store.ts";
import { IntegrationWorker } from "../integration.ts";
import { setTimeout as delay } from "node:timers/promises";
const [state, repo, ...ids] = process.argv.slice(2);
const store = new HandoffStore(state), queue = new IntegrationQueue(store), worker = new IntegrationWorker(store, repo);
try {
  const until = Date.now() + 20000;
  while (ids.some(id => ["queued", "running"].includes(queue.read(id).state))) {
    if (Date.now() > until) throw new Error("Workers did not drain integration queue");
    await worker.tick(); await delay(20);
  }
} finally { await worker.stop(); queue.close(); store.close(); }
