import { HandoffStore } from "../store.ts";

const [root, worker, countRaw] = process.argv.slice(2);
const store = new HandoffStore(root);
try {
  for (let index = 0; index < Number(countRaw); index++) {
    store.create({ to: "b", subject: `worker-${worker}-${index}`, body: `payload-${worker}-${index}`, items: ["one"] }, "a");
  }
  store.create({ to: "b", subject: "shared retry", body: "one action", items: ["one"], idempotencyKey: "concurrent-retry" }, "a");
} finally { store.close(); }
