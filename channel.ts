import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

export interface ChannelInfo {
  id: string;
  name: string;
  rootDir: string;
  source: "remote" | "git" | "cwd";
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 20);
const realPath = (value: string) => existsSync(value) ? realpathSync(value) : resolve(value);
const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

// Exact V3/V4 spelling, retained only to find existing databases.
function legacyRemote(raw: string): string {
  const value = raw.trim().replace(/\.git$/, "");
  try {
    const url = new URL(value);
    url.username = ""; url.password = ""; url.hash = ""; url.search = "";
    return url.toString().replace(/\/$/, "");
  } catch { return value.replace(/^[^@]+@(?=[^/:]+[:/])/, ""); }
}

function remoteInfo(raw: string, repoRoot: string): { alias: string; legacy: string[]; local: boolean } {
  const value = raw.trim();
  let url: URL | undefined;
  try { url = new URL(value); } catch {}
  if (url?.protocol === "file:") return { alias: `file:${realPath(fileURLToPath(url))}`, legacy: [legacyRemote(raw)], local: true };
  const scp = !value.includes("://") && /^(?:[^@/]+@)?([^/:]+):(.+)$/.exec(value);
  if (scp) url = undefined;
  if (url?.hostname || scp) {
    const host = (url?.hostname ?? scp![1]).toLowerCase();
    const path = (url?.pathname ?? scp![2]).replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
    const port = url?.port && !(url.protocol === "ssh:" && url.port === "22") ? `:${url.port}` : "";
    const authority = `${host}${port}`;
    return {
      alias: `remote:${authority}/${path}`, local: false,
      legacy: [legacyRemote(raw), `${authority}:${path}`, `https://${authority}/${path}`, `ssh://${authority}/${path}`, `http://${authority}/${path}`, `git://${authority}/${path}`],
    };
  }
  return { alias: `file:${realPath(resolve(repoRoot, value))}`, legacy: [legacyRemote(raw)], local: true };
}

function legacyDatabase(stateBase: string, id: string, commonDir?: string): { id: string; populated: boolean } | undefined {
  const path = join(stateBase, id, "pi-handoff", "handoff.sqlite");
  if (!existsSync(path)) return;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => String(row.name)));
    const populated = ["handoff_tasks", "messages", "board_entries"].some((table) => tables.has(table) && Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n) > 0);
    // A relative origin was formerly hashed without its base directory. Do not
    // adopt a database belonging to a different repository under the same spelling.
    if (commonDir && tables.has("handoff_sides")) {
      const owners = new Set(db.prepare("SELECT DISTINCT worktree FROM handoff_sides").all().flatMap((row) => {
        try { return [realPath(git(String(row.worktree), ["rev-parse", "--path-format=absolute", "--git-common-dir"]))]; }
        catch { return []; }
      }));
      if (owners.size > 1 && owners.has(commonDir)) throw new Error(`Legacy channel ${id} contains multiple projects; keep its database and separate that history before binding`);
      if (owners.size && !owners.has(commonDir)) return;
      if (!owners.size && populated) throw new Error(`Cannot establish the owner of legacy local-remote channel ${id}; database is preserved`);
    }
    return { id, populated };
  } finally { db.close(); }
}

export function resolveChannel(cwd: string, stateBase = process.env.PI_HANDOFF_STATE_DIR || join(homedir(), ".pi", "agent", "state", "pi-handoff")): ChannelInfo {
  const directory = realPath(cwd);
  let repoRoot: string | undefined;
  let commonDir: string | undefined;
  try {
    repoRoot = git(directory, ["rev-parse", "--show-toplevel"]);
    commonDir = realPath(git(directory, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  } catch {}
  let remote: ReturnType<typeof remoteInfo> | undefined;
  if (repoRoot) {
    let raw: string | undefined;
    try { raw = git(directory, ["remote", "get-url", "origin"]); } catch {}
    if (raw) {
      remote = remoteInfo(raw, repoRoot);
      // Earlier releases used the unexpanded config value rather than get-url.
      const configured = git(directory, ["config", "--get", "remote.origin.url"]);
      remote.legacy.push(legacyRemote(configured));
    }
  }
  const repoKey = commonDir ? `git:${commonDir}` : `cwd:${directory}`;
  const source = remote ? "remote" : commonDir ? "git" : "cwd";
  mkdirSync(stateBase, { recursive: true, mode: 0o700 });
  const registry = new DatabaseSync(join(stateBase, "channels.sqlite"));
  let id: string;
  try {
    // This small registry only runs at startup. Keep SQLite's default journal
    // mode: concurrent first opens must not race a journal-mode transition.
    registry.exec(`PRAGMA busy_timeout=30000; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS project_bindings (project TEXT PRIMARY KEY, channel TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS remote_aliases (alias TEXT PRIMARY KEY, channel TEXT NOT NULL);`);
    registry.exec("BEGIN IMMEDIATE");
    try {
      const bound = registry.prepare("SELECT channel FROM project_bindings WHERE project=?").get(repoKey);
      const alias = remote && registry.prepare("SELECT channel FROM remote_aliases WHERE alias=?").get(remote.alias);
      if (bound) id = String(bound.channel);
      else {
        const candidates = new Map<string, { id: string; populated: boolean }>();
        const common = legacyDatabase(stateBase, hash(repoKey));
        if (common) candidates.set(common.id, common);
        if (remote) for (const spelling of remote.legacy) {
          const previous = legacyDatabase(stateBase, hash(`remote:${spelling}`), remote.local ? commonDir : undefined);
          if (previous) candidates.set(previous.id, previous);
        }
        const populated = [...candidates.values()].filter((candidate) => candidate.populated);
        if (alias && populated.some((candidate) => candidate.id !== alias.channel) || populated.length > 1) {
          throw new Error("Multiple existing handoff histories resolve to this project. Databases are preserved; reconcile them before binding instead of hiding or renumbering tasks.");
        }
        id = alias ? String(alias.channel) : populated[0]?.id ?? [...candidates.keys()][0] ?? hash(remote?.alias ?? repoKey);
        registry.prepare("INSERT INTO project_bindings(project,channel) VALUES(?,?)").run(repoKey, id);
      }
      // A repository keeps its existing history even if origin later changes to
      // another known project. Never rebind the other project's discovery alias.
      if (remote) registry.prepare("INSERT OR IGNORE INTO remote_aliases(alias,channel) VALUES(?,?)").run(remote.alias, id);
      registry.exec("COMMIT");
    } catch (error) { registry.exec("ROLLBACK"); throw error; }
  } finally { registry.close(); }
  return { id, name: basename(repoRoot ?? directory), rootDir: join(stateBase, id), source };
}
