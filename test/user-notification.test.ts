import assert from "node:assert/strict";
import fs, { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import { userRequestNotification } from "../user-notification.ts";

async function fixture(run: (root: string, configure: (value: unknown) => void, tty: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "cowork-notification-"));
  const keys = ["PEBREL_PANE_ID", "NEBULA_PANE_ID"];
  const previous = keys.map((key) => [key, process.env[key]] as const);
  for (const key of keys) delete process.env[key];
  const config = join(root, ".unipi", "config", "notify");
  mkdirSync(config, { recursive: true });
  const configure = (value: unknown) => writeFileSync(join(config, "config.json"), JSON.stringify(value));
  configure({ defaultPlatforms: ["native"], native: { enabled: true } });
  const tty = join(root, "tty");
  const originalOpen = fs.openSync;
  mock.method(fs, "openSync", (path, ...args) => originalOpen(path === "/dev/tty" ? tty : path, ...args));
  const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
  try { await run(root, configure, tty); }
  finally {
    mock.restoreAll();
    if (stdoutTTY) Object.defineProperty(process.stdout, "isTTY", stdoutTTY); else delete process.stdout.isTTY;
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
}

test("desktop notification uses the emitting terminal without duplicating native delivery", async () => {
  await fixture(async (root, configure, tty) => {
    process.env.PEBREL_PANE_ID = "27";
    const notification = await userRequestNotification("actual-session", root, "CoWork 需要你配合", "#42 测试导入并报告错误");
    assert.deepEqual(notification, { terminalNotification: { transport: "pebrel", paneId: "27", submitted: true } });
    assert.equal(readFileSync(tty, "utf8"), "\x1b]9;CoWork 需要你配合：#42 测试导入并报告错误\x07");

    configure({ defaultPlatforms: ["native", "telegram"], native: { enabled: true } });
    const withPush = await userRequestNotification("actual-session", root, "title", "request");
    assert.deepEqual(withPush.userNotification?.platforms, ["telegram"]);
    assert.equal(withPush.userNotification?.priority, "high");
    assert.equal(withPush.terminalNotification?.paneId, "27");

    rmSync(tty);
    configure({ defaultPlatforms: ["telegram"], native: { enabled: true } });
    assert.equal((await userRequestNotification("actual-session", root, "title", "request")).terminalNotification, undefined);
    configure({ defaultPlatforms: ["native"], native: { enabled: false } });
    assert.equal((await userRequestNotification("actual-session", root, "title", "request")).terminalNotification, undefined);
    assert.equal(fs.existsSync(tty), false, "channel preferences never create an extra desktop notification");
  });
});

test("missing host, invalid pane, and unavailable terminal preserve the notify_user fallback", async () => {
  await fixture(async (root, configure, tty) => {
    const expected = { userNotification: { required: true, tool: "notify_user", title: "title", message: "request", priority: "high" } };
    assert.deepEqual(await userRequestNotification("session", root, "title", "request"), expected);
    process.env.PEBREL_PANE_ID = "27\nsource=other";
    assert.deepEqual(await userRequestNotification("session", root, "title", "request"), expected);
    process.env.PEBREL_PANE_ID = "27";
    mkdirSync(tty);
    assert.deepEqual(await userRequestNotification("session", root, "title", "request"), expected);
    configure({ defaultPlatforms: "malformed" });
    assert.deepEqual(await userRequestNotification("session", root, "title", "request"), expected);
  });
});

test("legacy terminal aliases use the emitting pane without borrowing another session", async () => {
  await fixture(async (root, _configure, tty) => {
    process.env.NEBULA_PANE_ID = "8";
    assert.equal((await userRequestNotification("restored-session", root, "title", "request")).terminalNotification?.paneId, "8");
    assert.equal(readFileSync(tty, "utf8"), "\x1b]9;title：request\x07");
  });
});

test("notification text cannot inject terminal controls or a different pane command", async () => {
  await fixture(async (root, _configure, tty) => {
    process.env.PEBREL_PANE_ID = "27";
    await userRequestNotification("actual-session", root, "title\x07", "line\n\x1b]0;other\x9c");
    const frame = readFileSync(tty, "utf8");
    assert.equal(frame, "\x1b]9;title ：line  ]0;other \x07");
    assert.equal([...frame].filter((ch) => ch === "\x1b").length, 1);
  });
});
