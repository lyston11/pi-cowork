import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { resolveChannel } from "../channel.ts";
import { HandoffStore } from "../store.ts";

const hash = (scope: string) => createHash("sha256").update(scope).digest("hex").slice(0, 20);
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function repo(path: string, remote?: string) {
  mkdirSync(path, { recursive: true }); git(path, "init", "-b", "main");
  if (remote) git(path, "remote", "add", "origin", remote);
  return path;
}
function history(state: string, id: string, worktree: string) {
  const store = new HandoffStore(join(state, id));
  for (const name of ["a", "b"]) store.register({ id: name, name, sessionId: name, pid: 1, worktree, branch: "main" });
  store.create({ to: "b", subject: "original", body: "preserve", items: ["done"] }, "a");
  store.check(1, "b", 1, true); store.complete(1, "b", "a".repeat(40), "original commit");
  store.close();
}
function assertHistory(rootDir: string) {
  const store = new HandoffStore(rootDir);
  try { assert.equal(store.read(1, "a").commit, "a".repeat(40)); assert.equal(store.read(1, "b").items[0].checked, true); }
  finally { store.close(); }
}

test("stable channel binding preserves history across origin edits, protocols, clones and linked worktrees", () => {
  const root = mkdtempSync(join(tmpdir(), "handoff-stable-channel-")), state = join(root, "state");
  try {
    const main = repo(join(root, "main"));
    writeFileSync(join(main, "fixture"), "fixture\n"); git(main, "add", "fixture");
    git(main, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture");
    const first = resolveChannel(main, state);
    history(state, first.id, main);
    git(main, "remote", "add", "origin", "https://example.test/Team/repo.git");
    assert.equal(resolveChannel(main, state).id, first.id);
    git(main, "remote", "set-url", "origin", "git@example.test:Team/repo.git");
    assert.equal(resolveChannel(main, state).id, first.id);
    const equivalent = repo(join(root, "clone"), "ssh://git@example.test:22/Team/repo.git");
    assert.equal(resolveChannel(equivalent, state).id, first.id);
    const linked = join(root, "linked"); git(main, "worktree", "add", "-b", "other", linked);
    assert.equal(resolveChannel(linked, state).id, first.id);
    git(main, "remote", "remove", "origin");
    assert.equal(resolveChannel(main, state).id, first.id);
    assertHistory(first.rootDir);
    const different = repo(join(root, "other-project"), "https://example.test/Other/repo.git");
    const other = resolveChannel(different, state);
    git(main, "remote", "add", "origin", "https://example.test/Other/repo.git");
    assert.equal(resolveChannel(main, state).id, first.id);
    assert.equal(resolveChannel(different, state).id, other.id);
    assert.notEqual(first.id, other.id);
    assert.equal(git(main, "status", "--porcelain"), "");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("relative local remotes resolve against each repository and file URLs share their real destination", () => {
  const root = mkdtempSync(join(tmpdir(), "handoff-local-channel-")), state = join(root, "state");
  try {
    const a = repo(join(root, "a", "work"), "../remote.git");
    const b = repo(join(root, "b", "work"), "../remote.git");
    for (const path of [join(root, "a", "remote.git"), join(root, "b", "remote.git")]) mkdirSync(path);
    const first = resolveChannel(a, state), second = resolveChannel(b, state);
    assert.notEqual(first.id, second.id);
    const equivalent = repo(join(root, "clone"), pathToFileURL(join(root, "a", "remote.git")).href);
    assert.equal(resolveChannel(equivalent, state).id, first.id);
    const oldState = join(root, "old-state"), legacy = hash("remote:../remote");
    history(oldState, legacy, a);
    assert.notEqual(resolveChannel(b, oldState).id, legacy);
    assert.equal(resolveChannel(a, oldState).id, legacy);
    assertHistory(join(oldState, legacy));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("legacy common-dir and alternate-protocol databases retain task numbers, ownership and original tables", () => {
  const root = mkdtempSync(join(tmpdir(), "handoff-legacy-channel-"));
  try {
    for (const origin of ["common", "protocol", "rewrite"]) {
      const state = join(root, origin, "state"), main = repo(join(root, origin, "main"));
      const id = hash(origin === "common" ? `git:${git(main, "rev-parse", "--path-format=absolute", "--git-common-dir")}` : origin === "protocol" ? "remote:https://example.test/team/repo" : "remote:corp:team/repo");
      history(state, id, main);
      const db = new DatabaseSync(join(state, id, "pi-handoff", "handoff.sqlite"));
      db.exec("CREATE TABLE messages(body TEXT); INSERT INTO messages VALUES('original V3');"); db.close();
      if (origin === "rewrite") git(main, "config", "url.https://example.test/.insteadOf", "corp:");
      git(main, "remote", "add", "origin", origin === "rewrite" ? "corp:team/repo.git" : "git@example.test:team/repo.git");
      const channel = resolveChannel(main, state);
      assert.equal(channel.id, id); assertHistory(channel.rootDir);
      const check = new DatabaseSync(join(channel.rootDir, "pi-handoff", "handoff.sqlite"), { readOnly: true });
      assert.equal(check.prepare("SELECT body FROM messages").get()!.body, "original V3"); check.close();
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ambiguous populated legacy histories fail explicitly without hiding or modifying either history", () => {
  const root = mkdtempSync(join(tmpdir(), "handoff-conflict-channel-")), state = join(root, "state");
  try {
    const main = repo(join(root, "main"), "https://example.test/team/repo.git");
    const ids = [hash("remote:https://example.test/team/repo"), hash("remote:example.test:team/repo")];
    for (const id of ids) history(state, id, main);
    assert.throws(() => resolveChannel(main, state), /Multiple existing handoff histories/);
    for (const id of ids) assertHistory(join(state, id));
    assert(existsSync(join(state, "channels.sqlite")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("concurrent first connections from equivalent remote spellings choose the same channel", async () => {
  const root = mkdtempSync(join(tmpdir(), "handoff-concurrent-channel-")), state = join(root, "state");
  try {
    const remotes = ["https://example.test/team/repo.git", "git@example.test:team/repo.git", "ssh://git@example.test/team/repo.git", "example.test:team/repo.git"];
    const repos = remotes.map((remote, index) => repo(join(root, String(index)), remote));
    const channels = await Promise.all(repos.map((path) => new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", `import {resolveChannel} from ${JSON.stringify(new URL("../channel.ts", import.meta.url).href)}; console.log(resolveChannel(process.argv[1], process.argv[2]).id);`, path, state], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "", err = ""; child.stdout.on("data", (data) => { out += data; }); child.stderr.on("data", (data) => { err += data; });
      child.on("error", reject); child.on("close", (code) => code === 0 ? resolve(out.trim()) : reject(new Error(err)));
    })));
    assert.equal(new Set(channels).size, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
