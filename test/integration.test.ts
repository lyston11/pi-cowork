import { spawnSync, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import test from "node:test";
import { WorkspaceLedger } from "../workspaces.ts";
import { HandoffStore } from "../store.ts";
import { IntegrationQueue } from "../integration-store.ts";
import { IntegrationWorker, integrationRepository, verifyPushedIntegration } from "../integration.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-main-integration-"));
  const remote = join(root, "remote.git"), repo = join(root, "project"), state = join(root, "state");
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(root, "init", "--bare", "--initial-branch=main", remote);
  git(root, "clone", remote, repo);
  git(repo, "config", "user.name", "Integration test"); git(repo, "config", "user.email", "integration@example.invalid");
  writeFileSync(join(repo, "base.txt"), "base\n"); git(repo, "add", "."); git(repo, "commit", "-m", "base"); git(repo, "push", "origin", "main");
  const base = git(repo, "rev-parse", "HEAD");
  const store = new HandoffStore(state), queue = new IntegrationQueue(store);
  const sides = ["a", "b", "c"].map(id => ({ id, name: id, sessionId: id, pid: process.pid, worktree: repo, branch: "main" }));
  sides.forEach(side => store.register(side));
  const target = integrationRepository(repo);
  const code = (name: string, file: string, content: string) => {
    const path = join(root, name); git(repo, "worktree", "add", "-b", name, path, base);
    writeFileSync(join(path, file), content); git(path, "add", file); git(path, "commit", "-m", name);
    return git(path, "rev-parse", "HEAD");
  };
  const task = (commit: string, assignee = "b") => {
    const task = store.create({ to: assignee, subject: "review and integrate", body: "authorized code delivery", items: ["done"], requiresIntegration: true }, "a");
    store.check(task.id, assignee, 1, true); store.complete(task.id, assignee, commit, "actual delivery"); return task.id;
  };
  const enqueue = (id: number, commit: string, script = "process.exit(0)", retry = false) => queue.enqueue({ taskId: id, actor: "a", commit,
    repo: target.repo, remoteFingerprint: target.fingerprint, reviewedBase: base,
    checks: [{ command: process.execPath, args: ["-e", script] }], note: "Reviewed every change from base to delivery; merge/push authorized", retry });
  return { root, remote, repo, state, store, queue, base, target, git, code, task, enqueue,
    cleanup() { queue.close(); store.close(); rmSync(root, { recursive: true, force: true }); } };
}

async function consume(f: ReturnType<typeof fixture>) {
  const worker = new IntegrationWorker(f.store, f.target.repo);
  try { await worker.tick(); } finally { await worker.stop(); }
}

test("only reviewed creator can queue; code closure is guarded even for legacy SQL; retry is explicit", async () => {
  const f = fixture();
  try {
    const commit = f.code("feature", "a.txt", "A\n"), id = f.task(commit);
    assert.throws(() => f.store.closeTask(id, "a", commit, "premature"), /Integrate and push/);
    const raw = new DatabaseSync(f.store.dbPath);
    try { assert.throws(() => raw.prepare("INSERT INTO handoff_task_events(task_id,actor,kind,data_json,at) VALUES(?,?,'close',?,?)").run(id, "a", JSON.stringify({ commit, note: "old writer" }), new Date().toISOString()), /Integrate and push/); }
    finally { raw.close(); }
    const job = f.enqueue(id, commit, "process.exit(7)");
    assert.equal(f.enqueue(id, commit).jobId, job.jobId);
    assert.throws(() => f.store.reopen(id, 'a', 'must not race with integration'), /queued\/running/);
    assert.throws(() => f.store.cancel(id, "a", "must not race with integration"), /queued\/running/);
    await consume(f);
    assert.equal(f.queue.read(job.jobId).state, "blocked");
    assert.equal(f.git(f.repo, "ls-remote", "origin", "refs/heads/main").split(/\s/)[0], f.base);
    assert.throws(() => f.store.closeTask(id, "a", commit, "failed check"), /Integrate and push/);
    assert.throws(() => f.enqueue(id, commit), /explicitly retry/);
    f.enqueue(id, commit, "require('node:assert').equal(require('node:fs').readFileSync('a.txt','utf8'),'A\\n')", true);
    await consume(f);
    const pushed = f.queue.read(job.jobId);
    assert.equal(pushed.state, "pushed", pushed.note); verifyPushedIntegration(f.repo, pushed);
    assert.match(f.git(f.repo, "log", "-1", "--format=%s", pushed.mainCommit!), /^Merge CoWork #/);
    assert(f.git(f.repo, "for-each-ref", "--format=%(refname)", "refs/pi-cowork/integrations").includes(`/${job.jobId}/closure`));
    assert.throws(() => f.store.reopen(id, 'a', 'already merged'), /Already integrated/);
    const old = new DatabaseSync(f.store.dbPath);
    try { assert.throws(() => old.prepare("INSERT INTO handoff_task_events(task_id,actor,kind,data_json,at) VALUES(?,?,'close',?,?)").run(id, 'a', JSON.stringify({ commit, note: 'missing integration receipt' }), new Date().toISOString()), /Integrate and push/); } finally { old.close(); }
    const closed = f.store.closeTask(id, "a", commit, "reviewed and integrated");
    assert.equal(closed.state, "closed");
    assert.equal(closed.events.at(-1)!.data.mainCommit, pushed.mainCommit);
    assert.equal(closed.events.at(-1)!.data.jobId, job.jobId);
    assert.equal(f.git(f.repo, "rev-parse", "main"), pushed.mainCommit, "safe fast-forward is independent of the Pi process cwd");
    assert.equal(f.git(f.repo, "status", "--porcelain"), "");
  } finally { f.cleanup(); }
});

test('cancellation cannot race queued/running work; blocked jobs may cancel without losing commits', async () => {
 const f=fixture();try{
  const commit=f.code('cancel-queued','cancel.txt','keep\n'),id=f.task(commit),job=f.enqueue(id,commit,'process.exit(9)');
  const raw=new DatabaseSync(f.store.dbPath);
  const cancelSql=()=>raw.prepare("INSERT INTO handoff_task_events(task_id,actor,kind,data_json,at) VALUES(?,?,'cancel',?,?)").run(id,'a',JSON.stringify({reason:'legacy cancellation'}),new Date().toISOString());
  try {
   assert.throws(cancelSql,/queued\/running/);
   const claimed=f.queue.claim(f.target.repo,'cancel-test');assert.equal(claimed!.state,'running');
   assert.throws(()=>f.store.cancel(id,'a','race running'),/queued\/running/);assert.throws(cancelSql,/queued\/running/);
   f.queue.finish(job.jobId,'blocked','check failed');
  }finally{raw.close();}
  assert.equal(f.store.cancel(id,'a','superseded before push').state,'cancelled');
  assert.throws(()=>f.enqueue(id,commit,'process.exit(0)',true),/completed commit/);
  assert.equal(f.git(f.repo,'show',commit+':cancel.txt'),'keep');
 }finally{f.cleanup();}
});

function child(args: string[], cwd?: string): Promise<void> {
  return new Promise((done, fail) => {
    const process = spawn(globalThis.process.execPath, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; process.stdout.on("data", data => output += data); process.stderr.on("data", data => output += data);
    process.on("error", fail); process.on("exit", code => code === 0 ? done() : fail(new Error(output)));
  });
}

test("two actual worker processes integrate independent branches serially without losing dirty main files", async () => {
  const f = fixture();
  try {
    const a = f.code("feature-a", "a.txt", "A\n"), b = f.code("feature-b", "b.txt", "B\n");
    const first = f.enqueue(f.task(a), a, "setTimeout(()=>{},120)"), second = f.enqueue(f.task(b, "c"), b);
    writeFileSync(join(f.repo, "base.txt"), "uncommitted work must survive\n");
    const worker = new URL("./integration-worker.ts", import.meta.url).pathname;
    await Promise.all([child([worker, f.state, f.target.repo, first.jobId, second.jobId]), child([worker, f.state, f.target.repo, first.jobId, second.jobId])]);
    assert.equal(f.queue.read(first.jobId).state, "pushed"); assert.equal(f.queue.read(second.jobId).state, "pushed");
    const head = f.git(f.repo, "ls-remote", "origin", "refs/heads/main").split(/\s/)[0];
    f.git(f.repo, "merge-base", "--is-ancestor", a, head); f.git(f.repo, "merge-base", "--is-ancestor", b, head);
    assert.equal(f.git(f.repo, "show", `${head}:a.txt`), "A"); assert.equal(f.git(f.repo, "show", `${head}:b.txt`), "B");
    assert.equal(readFileSync(join(f.repo, "base.txt"), "utf8"), "uncommitted work must survive\n");
    f.git(f.repo, "merge-base", "--is-ancestor", f.git(f.repo, "rev-parse", "main"), head);
  } finally { f.cleanup(); }
});

test('slow local main synchronization cannot hold the target lock or delay the next reviewed delivery',async()=>{
  const f=fixture(),original=WorkspaceLedger.prototype.syncMain;
  let release!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(done=>{release=done;}),started=new Promise<void>(done=>{entered=done;});
  WorkspaceLedger.prototype.syncMain=async function(cwd){entered();await gate;return original.call(this,cwd);};
  const worker=new IntegrationWorker(f.store,f.target.repo);
  try{
    const a=f.code('first-sync','a.txt','A\n'),b=f.code('next-sync','b.txt','B\n');
    const first=f.enqueue(f.task(a),a),next=f.enqueue(f.task(b,'c'),b);
    await worker.tick();await started;
    assert.equal(f.queue.read(first.jobId).state,'pushed');
    // The local update is still held at the gate, but the next merge can finish.
    await worker.tick();assert.equal(f.queue.read(next.jobId).state,'pushed');
    assert.equal(f.git(f.repo,'rev-parse','main'),f.base);
    const head=f.queue.read(next.jobId).mainCommit!;
    f.git(f.repo,'merge-base','--is-ancestor',a,head);f.git(f.repo,'merge-base','--is-ancestor',b,head);
    assert.equal(f.store.closeTask(first.taskId,'a',a,'remote integration reviewed').state,'closed');
  }finally{release();await worker.stop();WorkspaceLedger.prototype.syncMain=original;f.cleanup();}
});

test("a conflicting branch blocks while later independent work can still integrate", async () => {
  const f = fixture();
  try {
    const a = f.code("first", "base.txt", "one\n"), b = f.code("conflict", "base.txt", "two\n"), c = f.code("independent", "c.txt", "C\n");
    const first = f.enqueue(f.task(a), a), conflict = f.enqueue(f.task(b), b), later = f.enqueue(f.task(c), c);
    await consume(f); await consume(f); await consume(f);
    assert.equal(f.queue.read(first.jobId).state, "pushed");
    assert.equal(f.queue.read(conflict.jobId).state, "blocked"); assert.match(f.queue.read(conflict.jobId).note, /CONFLICT|conflict/);
    assert.equal(f.queue.read(later.jobId).state, "pushed");
    const main = f.queue.read(later.jobId).mainCommit!;
    assert.equal(f.git(f.repo, "show", `${main}:base.txt`), "one"); assert.equal(f.git(f.repo, "show", `${main}:c.txt`), "C");
    assert.throws(() => f.store.closeTask(conflict.taskId, "a", b, "should not close"), /Integrate and push/);
  } finally { f.cleanup(); }
});

test("remote advances during checks: rejected push rebuilds from latest main and repeats checks", async () => {
  const f = fixture();
  try {
    const external = join(f.root, "external"); f.git(f.root, "clone", f.remote, external);
    f.git(external, "config", "user.name", "Other clone"); f.git(external, "config", "user.email", "other@example.invalid");
    const commit = f.code("delivery", "delivery.txt", "delivered\n"), marker = join(f.root, "checks.txt");
    const job = f.enqueue(f.task(commit), commit, `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(marker)},'run\\n');setTimeout(()=>{},700)`);
    const worker = new IntegrationWorker(f.store, f.target.repo);
    const running = worker.tick();
    try {
      for (let i = 0; i < 200 && !existsSync(marker); i++) await delay(10);
      assert(existsSync(marker));
      writeFileSync(join(external, "external.txt"), "other clone\n"); f.git(external, "add", "."); f.git(external, "commit", "-m", "external change");
      f.git(external, "push", "origin", "main");
      await running;
      const result = f.queue.read(job.jobId);
      assert.equal(result.state, "pushed");
      assert.equal(f.git(f.repo, "show", `${result.mainCommit}:external.txt`), "other clone");
      assert.equal(f.git(f.repo, "show", `${result.mainCommit}:delivery.txt`), "delivered");
      assert.equal(readFileSync(marker, "utf8").trim().split("\n").length, 2, "integration checks must rerun on the new combined tree");
    } finally { await worker.stop(); }
  } finally { f.cleanup(); }
});

test("push refusal records a blocker and does not close or rewrite local source", async () => {
  const f = fixture();
  try {
    const { chmodSync } = await import("node:fs");
    const hook = join(f.remote, "hooks", "pre-receive"); writeFileSync(hook, "#!/bin/sh\nexit 1\n"); chmodSync(hook, 0o755);
    const commit = f.code("refused", "refused.txt", "keep\n"), job = f.enqueue(f.task(commit), commit);
    await consume(f);
    assert.equal(f.queue.read(job.jobId).state, "blocked");
    assert.equal(f.git(f.repo, "ls-remote", "origin", "refs/heads/main").split(/\s/)[0], f.base);
    assert.equal(f.git(f.repo, "show", `${commit}:refused.txt`), "keep");
    assert.equal(f.store.read(job.taskId, "a").state, "completed");
  } finally { f.cleanup(); }
});

test("dead worker claim is recovered and already pushed code is checked again before closure", async () => {
  const f = fixture();
  try {
    const commit = f.code("recovered", "ready.txt", "ready\n"), id = f.task(commit), marker = join(f.root, "rechecked");
    const job = f.enqueue(id, commit, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'checked')`);
    const storeURL = new URL("../store.ts", import.meta.url).href, queueURL = new URL("../integration-store.ts", import.meta.url).href;
    const script = `import {HandoffStore} from ${JSON.stringify(storeURL)};import {IntegrationQueue} from ${JSON.stringify(queueURL)};const s=new HandoffStore(${JSON.stringify(f.state)});const q=new IntegrationQueue(s);q.claim(${JSON.stringify(f.target.repo)});process.exit(0);`;
    const exited = spawnSync(process.execPath, ["--input-type=module", "-e", script]); assert.equal(exited.status, 0, exited.stderr.toString());
    f.git(f.repo, "push", "origin", `${commit}:refs/heads/main`);
    await consume(f);
    assert.equal(f.queue.read(job.jobId).state, "pushed"); assert(existsSync(marker));
    assert.equal(f.queue.read(job.jobId).attempts, 2);
    verifyPushedIntegration(f.repo, f.queue.read(job.jobId));
  } finally { f.cleanup(); }
});

test('reload stops an unresponsive check, preserves its job, and the next worker safely resumes', async () => {
  const f = fixture();
  try {
    const commit = f.code('interrupt', 'resumed.txt', 'resume safely\n'), marker = join(f.root, 'once');
    const job = f.enqueue(f.task(commit), commit, `const fs=require('node:fs');if(!fs.existsSync(${JSON.stringify(marker)})){fs.writeFileSync(${JSON.stringify(marker)},'started');process.on('SIGTERM',()=>{});setInterval(()=>{},1000)}`);
    const worker = new IntegrationWorker(f.store, f.target.repo);
    const running = worker.tick();
    try {
      for (let i = 0; i < 200 && !existsSync(marker); i++) await delay(10);
      assert(existsSync(marker), 'check must be executing before shutdown');
    } finally { await worker.stop(); await running; }
    assert.equal(f.queue.read(job.jobId).state, 'queued');
    assert.equal(f.git(f.repo, 'ls-remote', 'origin', 'refs/heads/main').split(/\s/)[0], f.base);
    await consume(f);
    assert.equal(f.queue.read(job.jobId).state, 'pushed');
    assert.equal(f.queue.read(job.jobId).attempts, 2);
  } finally { f.cleanup(); }
});

test('only the creator can approve integration and legacy review tasks opt in explicitly', async () => {
  const f = fixture();
  try {
    const commit = f.code('legacy', 'legacy.txt', 'legacy\n');
    const t = f.store.create({to:'b',subject:'old review task',body:'existing record',items:['done'],requiresIntegration:false},'a');
    f.store.check(t.id,'b',1,true);f.store.complete(t.id,'b',commit,'ready');
    assert.throws(() => f.queue.enqueue({taskId:t.id,actor:'b',commit,repo:f.target.repo,remoteFingerprint:f.target.fingerprint,reviewedBase:f.base,checks:[{command:process.execPath,args:['-e','process.exit(0)']}],note:'cannot approve own delivery'}), /Only the creator/);
    const job=f.enqueue(t.id,commit);
    assert.equal(f.store.read(t.id,'a').requiresIntegration,true);
    assert.throws(() => f.store.closeTask(t.id,'a',commit,'premature'), /Integrate and push/);
    await consume(f);
    assert.equal(f.store.closeTask(t.id,'a',commit,'integrated').events.at(-1)!.data.mainCommit,f.queue.read(job.jobId).mainCommit);
  } finally { f.cleanup(); }
});

test("changed origin and rewritten remote main cannot pass closure verification", async () => {
  const f = fixture();
  try {
    const commit = f.code("origin-change", "a.txt", "A\n"), job = f.enqueue(f.task(commit), commit);
    const other = join(f.root, "other.git"); f.git(f.root, "init", "--bare", "--initial-branch=main", other);
    f.git(f.repo, "remote", "set-url", "origin", other);
    await consume(f); assert.equal(f.queue.read(job.jobId).state, "blocked");
    f.git(f.repo, "remote", "set-url", "origin", f.remote);
    f.enqueue(job.taskId, commit, "process.exit(0)", true); await consume(f);
    const integrated = f.queue.read(job.jobId); assert.equal(integrated.state, "pushed");
    f.git(f.remote, "update-ref", "refs/heads/main", f.base);
    assert.throws(() => verifyPushedIntegration(f.repo, integrated), /no longer contains/);
  } finally { f.cleanup(); }
});
