import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { IntegrationQueue } from "./integration-store.ts";
import type { HandoffStore } from "./store.ts";
import type { IntegrationJob } from "./types.ts";

function gitSync(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function integrationRepository(cwd: string): { repo: string; url: string; fingerprint: string } {
  const repo = realpathSync(resolve(cwd, gitSync(cwd, ["rev-parse", "--git-common-dir"])));
  // Resolve local remotes against the repository, not the temporary worktree.
  const anchor = gitSync(dirname(repo), ["--git-dir", repo, "rev-parse", "--is-bare-repository"]) === "true" ? repo : dirname(repo);
  const normalize = (value: string) => {
    if (value.startsWith("file://")) return realpathSync(fileURLToPath(value));
    if (isAbsolute(value) || value.startsWith(".")) return realpathSync(resolve(anchor, value));
    if (!value.includes(":") && !value.includes("@")) return realpathSync(resolve(anchor, value));
    return value;
  };
  const fetchUrls = gitSync(anchor, ["--git-dir", repo, "remote", "get-url", "--all", "origin"]).split("\n").map(normalize);
  const pushUrls = gitSync(anchor, ["--git-dir", repo, "remote", "get-url", "--push", "--all", "origin"]).split("\n").map(normalize);
  if (fetchUrls.length !== 1 || pushUrls.length !== 1 || fetchUrls[0] !== pushUrls[0]) throw new Error("Integration requires one origin with the same fetch and push destination");
  let mirror = "";
  try { mirror = gitSync(anchor, ["--git-dir", repo, "config", "--get", "remote.origin.mirror"]); } catch {}
  if (mirror === "true") throw new Error("Mirror remotes cannot be used for integration");
  return { repo, url: pushUrls[0], fingerprint: createHash("sha256").update(pushUrls[0]).digest("hex") };
}

export function verifyPushedIntegration(cwd: string, job: IntegrationJob): void {
  const current = integrationRepository(cwd);
  if (current.repo !== job.repo || current.fingerprint !== job.remoteFingerprint) throw new Error("Repository/origin changed since integration; verify the intended target before closing");
  if (job.state !== "pushed" || !job.mainCommit) throw new Error("Integration has not been pushed");
  const ref = `refs/pi-handoff/integrations/${job.jobId}/closure`;
  gitSync(cwd, ["fetch", "--no-tags", "--no-write-fetch-head", "--", current.url, `+refs/heads/main:${ref}`]);
  try {
    gitSync(cwd, ["merge-base", "--is-ancestor", job.commit, ref]);
    gitSync(cwd, ["merge-base", "--is-ancestor", job.mainCommit, ref]);
  } catch { throw new Error("Remote main no longer contains the reviewed integration; do not close this task"); }
}

export class IntegrationWorker {
  private stopped = false;
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private controller?: AbortController;
  private queue: IntegrationQueue;
  private store: HandoffStore;
  private repo: string;
  constructor(store: HandoffStore, repo: string) { this.store = store; this.repo = repo; this.queue = new IntegrationQueue(store); }

  start(): void {
    const tick = () => { void this.tick().catch(error => console.error("Handoff integration worker:", error)); };
    this.timer = setInterval(tick, 1000);
    this.timer.unref();
    tick();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.controller?.abort();
    await this.running;
    this.queue.close();
  }
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.runOne().finally(() => { this.running = undefined; });
    return this.running;
  }
  private command(cwd: string, command: string, args: string[], timeout = 120000): Promise<string> {
    return new Promise((done, fail) => {
      let output = "";
      const signal = this.controller?.signal;
      if (signal?.aborted) { fail(new Error("Integration stopped")); return; }
      const child = spawn(command, args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
      let error: Error | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const kill = (value: NodeJS.Signals) => {
        try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, value); else child.kill(value); } catch {}
      };
      const stop = (reason: Error) => {
        if (error) return;
        error = reason; kill("SIGTERM");
        killTimer = setTimeout(() => { kill("SIGKILL"); }, 2000);
        killTimer.unref();
      };
      const abort = () => stop(new Error("Integration stopped"));
      signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => stop(new Error(`${command} timed out`)), timeout);
      timer.unref();
      const consume = (data: Buffer) => { output = (output + data.toString()).slice(-12000); };
      child.stdout.on("data", consume); child.stderr.on("data", consume);
      child.on("error", reason => { error = reason; });
      child.on("close", code => { clearTimeout(timer); if (killTimer) clearTimeout(killTimer); signal?.removeEventListener("abort", abort); if (error || code !== 0) fail(error ?? new Error(`${command} ${args.slice(0, 3).join(" ")} failed (${code}): ${output}`)); else done(output.trim()); });
    });
  }
  private git(args: string[], cwd = dirname(this.repo)): Promise<string> {
    return this.command(cwd, "git", cwd === dirname(this.repo) ? ["--git-dir", this.repo, ...args] : args);
  }
  private async ancestor(base: string, commit: string): Promise<boolean> {
    try { await this.git(["merge-base", "--is-ancestor", base, commit]); return true; } catch { return false; }
  }
  private async runOne(): Promise<void> {
    let job: IntegrationJob | null = null;
    let worktree: string | undefined;
    let pushed: string | undefined;
    this.controller = new AbortController();
    try {
      job = this.queue.claim(this.repo);
      if (!job) return;
      if (job.attempts > 3) throw new Error("Integration repeatedly interrupted; review the job and explicitly retry");
      const task = this.store.read(job.taskId, job.creator);
      if (task.state !== "completed" || task.commit !== job.commit) throw new Error("Delivery changed after review; review again before integration");
      const repository = integrationRepository(dirname(this.repo));
      if (repository.fingerprint !== job.remoteFingerprint) throw new Error("origin changed after review; integration requires a new explicit review/retry");
      if (!await this.ancestor(job.reviewedBase, job.commit)) throw new Error("Reviewed base is not an ancestor of the delivered commit");
      const ref = `refs/pi-handoff/integrations/${job.jobId}`;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (worktree) { await this.git(["worktree", "remove", worktree]); worktree = undefined; }
        const remoteRef = `${ref}/remote`;
        await this.git(["fetch", "--no-tags", "--no-write-fetch-head", "--", repository.url, `+refs/heads/main:${remoteRef}`]);
        const target = await this.git(["rev-parse", remoteRef]);
        if (!await this.ancestor(job.reviewedBase, target)) throw new Error("Reviewed base is outside origin/main history; review the whole branch before retrying");
        const included = await this.ancestor(job.commit, target);
        worktree = join(this.store.rootDir, "integrations", createHash("sha256").update(this.repo).digest("hex").slice(0, 16), `${job.jobId}-${randomUUID()}`);
        mkdirSync(dirname(worktree), { recursive: true, mode: 0o700 });
        await this.git(["worktree", "add", "--detach", worktree, target]);
        if (!included) await this.git(["-c", "user.name=Pi Handoff", "-c", "user.email=pi-handoff@localhost", "merge", "--no-ff", "--no-edit", job.commit], worktree);
        const merged = await this.git(["rev-parse", "HEAD"], worktree);
        for (const check of job.checks) await this.command(worktree, check.command, check.args, 600000);
        if (await this.git(["rev-parse", "HEAD"], worktree) !== merged || await this.git(["status", "--porcelain", "--untracked-files=no"], worktree)) throw new Error("Integration checks changed HEAD or tracked files; nothing was pushed");
        if (integrationRepository(dirname(this.repo)).fingerprint !== job.remoteFingerprint) throw new Error("origin changed during checks; nothing was pushed");
        await this.git(["update-ref", `${ref}/candidate`, merged]);
        try { await this.git(["push", "--porcelain", "--", repository.url, `${merged}:refs/heads/main`]); pushed = merged; break; }
        catch (error) {
          // A concurrent clone may have advanced main. Rebuild and recheck from
          // that new tip; never force push or reuse a stale merged tree.
          await this.git(["fetch", "--no-tags", "--no-write-fetch-head", "--", repository.url, `+refs/heads/main:${remoteRef}`]);
          const latest = await this.git(["rev-parse", remoteRef]);
          if (latest === target || !await this.ancestor(target, latest) || attempt === 2) throw error;
        }
      }
      if (!pushed) throw new Error("Integration did not produce a pushed main commit");
      // Confirm the server still contains this integration, including the case
      // where the push succeeded but the client lost the response.
      const visible = await this.git(["ls-remote", "--", repository.url, "refs/heads/main"]);
      const server = visible.split(/\s+/)[0];
      if (server !== pushed) {
        await this.git(["fetch", "--no-tags", "--no-write-fetch-head", "--", repository.url, `+refs/heads/main:${ref}/confirmed`]);
        const confirmed = await this.git(["rev-parse", `${ref}/confirmed`]);
        if (!await this.ancestor(pushed, confirmed)) throw new Error("Remote main no longer contains the integration; recheck before closure");
      }
      this.queue.finish(job.jobId, "pushed", `已核实 origin/main 包含交付提交，通过 ${job.checks.length} 项合并后检查。集成提交 ${pushed}；本地主检出及各侧工作区未被重置。${job.note}`, pushed);
    } catch (error) {
      if (job) this.queue.finish(job.jobId, this.stopped ? "queued" : "blocked", `${error instanceof Error ? error.message : String(error)}${worktree ? `\n隔离工作树保留于 ${worktree}` : ""}`.replace(/(https?:\/\/)[^\s/]*@/g, "$1[redacted]@"), pushed);
    } finally {
      if (worktree && pushed) { try { await this.git(["worktree", "remove", worktree]); } catch { /* Preserve unexpected files rather than forcing cleanup. */ } }
      if (job) this.queue.release(this.repo);
      this.controller = undefined;
    }
  }
}
