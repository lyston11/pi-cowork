import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readlinkSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { git, gitSync, integrationRepository } from "./repository.ts";
import type { IntegrationCheck } from "./types.ts";
import type { HandoffStore } from "./store.ts";

export function initializeWorkspaces(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS handoff_workspaces (
      id TEXT PRIMARY KEY, repo TEXT NOT NULL, target_key TEXT NOT NULL,
      owner TEXT NOT NULL REFERENCES handoff_sides(id), path TEXT NOT NULL, branch TEXT NOT NULL,
      base TEXT NOT NULL, tasks_json TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'active', at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS handoff_workspace_path ON handoff_workspaces(repo,path) WHERE state='active';
    CREATE UNIQUE INDEX IF NOT EXISTS handoff_workspace_branch ON handoff_workspaces(repo,branch) WHERE state='active';
    CREATE TABLE IF NOT EXISTS handoff_deliveries (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES handoff_workspaces(id),
      base TEXT NOT NULL, tip TEXT NOT NULL, tree TEXT NOT NULL, commits_json TEXT NOT NULL,
      files_json TEXT NOT NULL, digest TEXT NOT NULL, ref TEXT NOT NULL, at TEXT NOT NULL,
      UNIQUE(workspace_id,base,tip)
    );
    CREATE TABLE IF NOT EXISTS handoff_workspace_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL REFERENCES handoff_workspaces(id),
      actor TEXT NOT NULL REFERENCES handoff_sides(id), kind TEXT NOT NULL, data_json TEXT NOT NULL, at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS handoff_integration_targets (
      target_key TEXT PRIMARY KEY, revision TEXT NOT NULL, baseline TEXT NOT NULL,
      checks_json TEXT NOT NULL, note TEXT NOT NULL, actor TEXT NOT NULL REFERENCES handoff_sides(id)
    );
    CREATE TABLE IF NOT EXISTS handoff_target_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, target_key TEXT NOT NULL, revision TEXT NOT NULL,
      baseline TEXT NOT NULL, checks_json TEXT NOT NULL, actor TEXT NOT NULL, note TEXT NOT NULL, at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS handoff_main_sync_locks (
      repo TEXT PRIMARY KEY, owner TEXT NOT NULL, pid INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS handoff_main_sync_results (
      repo TEXT PRIMARY KEY, result_json TEXT NOT NULL, at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS handoff_reconcile_observations (
      owner TEXT NOT NULL, repo TEXT NOT NULL, digest TEXT NOT NULL, report_json TEXT NOT NULL,
      PRIMARY KEY(owner,repo)
    );
  `);
  for (const table of ['handoff_deliveries', 'handoff_workspace_events', 'handoff_target_events']) db.exec(`
    CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'CoWork records are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'CoWork records are append-only'); END;
  `);
  // Store initialization runs this inside one transaction, so the old guards
  // remain effective until their error text is replaced atomically.
  const legacy = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND instr(sql,'Handoff records are append-only')>0").all();
  for (const row of legacy) {
    const name = String(row.name);
    if (!/^handoff_\w+_no_(update|delete)$/.test(name)) continue;
    db.exec(`DROP TRIGGER "${name}"; ${String(row.sql).replaceAll('Handoff records are append-only', 'CoWork records are append-only')}`);
  }
}

export interface Workspace {
  id: string; repo: string; targetKey: string; owner: string; path: string; branch: string; base: string;
  tasks: number[]; state: string;
}
export interface Delivery {
  id: string; workspaceId: string; base: string; tip: string; tree: string;
  commits: string[]; files: string[]; digest: string; ref: string;
}
const list = (value: string) => value ? value.split("\n") : [];
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; } };

export function workspaceOccupancy(path: string): string | null {
  if (process.platform !== 'linux') return 'Cannot prove process occupancy on this platform';
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if (statSync(`/proc/${entry}`).uid !== process.getuid!()) continue;
      const cwd = readlinkSync(`/proc/${entry}/cwd`);
      if ((cwd === path || cwd.startsWith(path + sep)) && alive(Number(entry))) return `Workspace occupied by PID ${entry}`;
      const args = readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0');
      if (alive(Number(entry)) && args.some(arg => arg === path || arg.startsWith(path + sep))) return `Workspace referenced by PID ${entry}`;
    } catch (error) { if (['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) return 'Cannot inspect all process occupancy'; }
  }
  return null;
}

// Synchronizing a checkout is different from deleting it. Git protects files
// during a fast-forward; live readers do not prevent it. An unfinished Git
// operation does, even if no process currently holds its index lock.
function mainGitOperation(path: string): string | null {
  for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-apply', 'rebase-merge', 'BISECT_START', 'index.lock', 'HEAD.lock']) {
    if (existsSync(resolve(path, gitSync(path, ['rev-parse', '--git-path', name])))) return `Main worktree has an unfinished Git operation: ${name}`;
  }
  return null;
}

type BranchStatus = {
  state: 'unknown' | 'merged' | 'patches-present' | 'materials-preserved' | 'unaccounted';
  unique: string[] | null;
  remaining: string[] | null;
  commits?: { commit: string; state: string; taskId?: number }[];
};

export class WorkspaceLedger {
  private db: DatabaseSync;
  private store: HandoffStore;
  constructor(store: HandoffStore) {
    this.store = store;
    this.db = new DatabaseSync(store.dbPath);
    this.db.exec('PRAGMA busy_timeout=30000; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;');
    this.db.exec('CREATE TABLE IF NOT EXISTS handoff_branch_retirements(id TEXT PRIMARY KEY,repo TEXT NOT NULL,actor TEXT NOT NULL,branch TEXT NOT NULL,tip TEXT NOT NULL,ref TEXT NOT NULL,note TEXT NOT NULL,evidence_json TEXT NOT NULL)');
  }
  close() { this.db.close(); }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private workspace(row: Record<string, unknown>): Workspace {
    return { id: String(row.id), repo: String(row.repo), targetKey: String(row.target_key), owner: String(row.owner),
      path: String(row.path), branch: String(row.branch), base: String(row.base), tasks: JSON.parse(String(row.tasks_json)), state: String(row.state) };
  }
  all(repo: string, owner?: string): Workspace[] {
    return this.db.prepare(`SELECT * FROM handoff_workspaces WHERE repo=? ${owner ? 'AND owner=?' : ''} ORDER BY at,id`)
      .all(repo, ...(owner ? [owner] : [])).map(row => this.workspace(row));
  }
  read(id: string, owner?: string): Workspace {
    const row = this.db.prepare(`SELECT * FROM handoff_workspaces WHERE id=? ${owner ? 'AND owner=?' : ''}`).get(id, ...(owner ? [owner] : []));
    if (!row) throw new Error('Workspace not found or not owned by this side');
    return this.workspace(row);
  }
  delivery(id: string): Delivery {
    const row = this.db.prepare('SELECT * FROM handoff_deliveries WHERE id=?').get(id);
    if (!row) throw new Error('Unknown delivery snapshot');
    return { id: String(row.id), workspaceId: String(row.workspace_id), base: String(row.base), tip: String(row.tip), tree: String(row.tree),
      commits: JSON.parse(String(row.commits_json)), files: JSON.parse(String(row.files_json)), digest: String(row.digest), ref: String(row.ref) };
  }
  async configure(cwd: string, actor: string, baseline: string, checks: IntegrationCheck[], note: string) {
    if (!note.trim() || note.length > 4000 || !checks.length || checks.length > 10 || checks.some(c => !c.command || /[\x00\r\n]/.test(c.command) || c.command.length > 512 || !Array.isArray(c.args) || c.args.length > 100 || c.args.some(a => typeof a !== 'string' || a.includes('\0') || a.length > 4096))) throw new Error('Provide a review note and 1-10 valid project checks');
    const target = integrationRepository(cwd), remote = await this.remoteHead(cwd);
    if (remote !== baseline) throw new Error('Review the exact current remote main before approving a target baseline');
    const revision = randomUUID();
    return this.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM handoff_integrations WHERE target_key=? AND state IN ('queued','running')").get(target.targetKey)) throw new Error('Wait for pending integrations before changing project policy');
      this.db.prepare('INSERT INTO handoff_integration_targets VALUES(?,?,?,?,?,?) ON CONFLICT(target_key) DO UPDATE SET revision=excluded.revision,baseline=excluded.baseline,checks_json=excluded.checks_json,note=excluded.note,actor=excluded.actor').run(target.targetKey, revision, baseline, JSON.stringify(checks), note, actor);
      this.db.prepare('INSERT INTO handoff_target_events(target_key,revision,baseline,checks_json,actor,note,at) VALUES(?,?,?,?,?,?,?)').run(target.targetKey, revision, baseline, JSON.stringify(checks), actor, note, new Date().toISOString());
      return this.policy(target.targetKey);
    });
  }
  async remoteHead(cwd: string): Promise<string> {
    const target = integrationRepository(cwd);
    const ref = 'refs/pi-cowork/reconciliation/main';
    await git(cwd, ['fetch', '--no-tags', '--no-write-fetch-head', '--', target.url, `+refs/heads/main:${ref}`]);
    return git(cwd, ['rev-parse', ref]);
  }
  async register(cwd: string, actor: string, taskIds: number[] = []): Promise<Workspace> {
    if (taskIds.length > 50 || new Set(taskIds).size !== taskIds.length) throw new Error('At most 50 unique task IDs are allowed');
    taskIds.forEach(id => this.store.read(id, actor));
    const target = integrationRepository(cwd), path = realpathSync(await git(cwd, ['rev-parse', '--show-toplevel']));
    const branch = await git(path, ['symbolic-ref', '-q', 'HEAD']);
    if (branch === 'refs/heads/main' || !branch.startsWith('refs/heads/')) throw new Error('Register an implementation branch, not main or detached HEAD');
    const current = this.all(target.repo).find(w => w.state === 'active' && (w.path === path || w.branch === branch));
    if (current) {
      if (current.owner !== actor || current.path !== path || current.targetKey !== target.targetKey) throw new Error('Workspace/branch is already registered to another owner or target; reconcile it first');
      return this.transaction(() => {
        const registered = this.read(current.id, actor);
        if (registered.state !== 'active' || registered.branch !== current.branch) throw new Error('Workspace registration changed; retry register');
        const tasks = [...new Set([...registered.tasks, ...taskIds])];
        if (registered.branch !== branch) {
          // A side can reuse its own worktree after switching task branches.
          // Keep the original base and immutable deliveries; only refresh the binding.
          if (gitSync(path, ['symbolic-ref', '-q', 'HEAD']) !== branch || gitSync(path, ['status', '--porcelain=v1', '-uall'])) throw new Error('Workspace changed or has uncommitted files; preserve them before registering the new branch');
          if (gitSync(path, ['worktree', 'list', '--porcelain', '-z']).split('\0').includes(`branch ${registered.branch}`)) throw new Error('Previous registered branch is still checked out; preserve its worktree');
          const tip = gitSync(path, ['rev-parse', 'HEAD']);
          const oldTip = list(gitSync(path, ['for-each-ref', '--format=%(refname) %(objectname)', registered.branch])).find(ref => ref.startsWith(registered.branch + ' '))?.split(' ')[1];
          if (!this.contains(path, registered.base, tip) || (oldTip && !this.contains(path, oldTip, tip))) throw new Error('New branch must retain the registered base and all previous branch commits');
          const deliveries = this.db.prepare('SELECT tip FROM handoff_deliveries WHERE workspace_id=?').all(registered.id);
          if (deliveries.some(d => !this.contains(path, String(d.tip), tip))) throw new Error('New branch must retain every preserved delivery');
          if (this.db.prepare("SELECT 1 FROM handoff_integrations j JOIN handoff_deliveries d ON d.id=j.delivery_id WHERE d.workspace_id=? AND j.state IN ('queued','running','blocked')").get(registered.id)) throw new Error('Workspace still has pending integrations; finish them before registering the new branch');
          if (gitSync(path, ['symbolic-ref', '-q', 'HEAD']) !== branch || gitSync(path, ['rev-parse', 'HEAD']) !== tip) throw new Error('Workspace changed during registration; retry register');
          this.db.prepare('UPDATE handoff_workspaces SET branch=?,tasks_json=? WHERE id=?').run(branch, JSON.stringify(tasks), registered.id);
          this.event(registered.id, actor, 'register', { previousBranch: registered.branch, previousTip: oldTip || null, branch, tip, path, base: registered.base });
        } else this.db.prepare('UPDATE handoff_workspaces SET tasks_json=? WHERE id=?').run(JSON.stringify(tasks), registered.id);
        return this.read(registered.id, actor);
      });
    }
    const head = await this.remoteHead(path), base = await git(path, ['merge-base', head, 'HEAD']);
    const id = randomUUID();
    return this.transaction(() => {
      this.db.prepare('INSERT INTO handoff_workspaces(id,repo,target_key,owner,path,branch,base,tasks_json,at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(id, target.repo, target.targetKey, actor, path, branch, base, JSON.stringify(taskIds), new Date().toISOString());
      this.event(id, actor, 'register', { base, branch, path });
      return this.read(id, actor);
    });
  }
  private event(id: string, actor: string, kind: string, data: unknown) {
    this.db.prepare('INSERT INTO handoff_workspace_events(workspace_id,actor,kind,data_json,at) VALUES(?,?,?,?,?)')
      .run(id, actor, kind, JSON.stringify(data), new Date().toISOString());
  }
  async snapshot(cwd: string, actor: string, taskId: number, tip: string): Promise<Delivery> {
    const task = this.store.read(taskId, actor);
    if (task.assignee.id !== actor || task.state !== 'open' || task.block || task.items.some(i => !i.checked)) throw new Error('Only a ready assigned task can create a delivery');
    const w = await this.register(cwd, actor, [taskId]);
    await git(cwd, ['merge-base', '--is-ancestor', w.base, tip]);
    await git(cwd, ['merge-base', '--is-ancestor', tip, 'HEAD']);
    const previous = this.db.prepare('SELECT id FROM handoff_deliveries WHERE workspace_id=? AND base=? AND tip=?').get(w.id, w.base, tip);
    if (previous) return this.delivery(String(previous.id));
    const commits = list(await git(cwd, ['rev-list', '--reverse', `${w.base}..${tip}`]));
    const files = (await git(cwd, ['diff', '--name-status', '-z', w.base, tip])).split('\0').filter(Boolean);
    const tree = await git(cwd, ['rev-parse', `${tip}^{tree}`]);
    const id = randomUUID(), ref = `refs/pi-cowork/deliveries/${id}`;
    const digest = createHash('sha256').update(JSON.stringify({ base: w.base, tip, tree, commits, files })).digest('hex');
    await git(cwd, ['update-ref', ref, tip, '']);
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT id FROM handoff_deliveries WHERE workspace_id=? AND base=? AND tip=?').get(w.id, w.base, tip);
      if (existing) return this.delivery(String(existing.id));
      this.db.prepare('INSERT INTO handoff_deliveries(id,workspace_id,base,tip,tree,commits_json,files_json,digest,ref,at) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(id, w.id, w.base, tip, tree, JSON.stringify(commits), JSON.stringify(files), digest, ref, new Date().toISOString());
      this.event(w.id, actor, 'delivery', { id, tip, digest });
      return this.delivery(id);
    });
  }
  policy(targetKey: string) {
    const row = this.db.prepare('SELECT * FROM handoff_integration_targets WHERE target_key=?').get(targetKey);
    return row ? { targetKey, revision: String(row.revision), baseline: String(row.baseline), checks: JSON.parse(String(row.checks_json)), note: String(row.note) } : null;
  }
  async outsideQueue(cwd: string, head: string): Promise<string[]> {
    const target = integrationRepository(cwd), policy = this.policy(target.targetKey);
    if (!policy) return [];
    await git(cwd, ['merge-base', '--is-ancestor', policy.baseline, head]);
    const history = list(await git(cwd, ['rev-list', '--first-parent', `${policy.baseline}..${head}`]));
    const receipts = new Set(this.db.prepare("SELECT main_commit FROM handoff_integrations WHERE target_key=? AND state='pushed'").all(target.targetKey).map(r => String(r.main_commit)));
    return history.filter(commit => !receipts.has(commit));
  }
  async reconcile(cwd: string, actor?: string) {
    const target = integrationRepository(cwd), workspaces = this.all(target.repo, actor).filter(w => w.state === 'active');
    const errors: string[] = [];
    let remote: string | null = null, outside: string[] = [], remoteBranches: string[] = [];
    // One atomic snapshot, not fetch(main) + ls-remote + fetch(all).
    // Prune only our audit namespace so deleted remote branches cannot linger.
    try {
      await git(cwd, ['fetch', '--atomic', '--prune', '--no-tags', '--no-write-fetch-head', '--', target.url, '+refs/heads/*:refs/pi-cowork/audit/heads/*']);
      remoteBranches = list(await git(cwd, ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/pi-cowork/audit/heads/']))
        .map(row => row.replace('refs/pi-cowork/audit/heads/', 'refs/heads/'));
      remote = remoteBranches.find(row => row.endsWith(' refs/heads/main'))?.split(' ')[0] ?? null;
      if (!remote) throw new Error('Remote main is missing; reconciliation is incomplete');
      outside = await this.outsideQueue(cwd, remote);
    } catch (e) { errors.push(String(e)); }
    const registered = this.all(target.repo).filter(w => w.state === 'active');
    const snapshots = this.db.prepare('SELECT d.* FROM handoff_deliveries d JOIN handoff_workspaces w ON w.id=d.workspace_id WHERE w.repo=?').all(target.repo);
    const worktrees = (await git(cwd, ['worktree', 'list', '--porcelain', '-z'])).split('\0\0').map(block => {
      const lines = block.split('\0');
      return { path: lines.find(l => l.startsWith('worktree '))?.slice(9), branch: lines.find(l => l.startsWith('branch '))?.slice(7), head: lines.find(l => l.startsWith('HEAD '))?.slice(5) };
    }).filter(w => w.path);
    const actualWorktrees = await Promise.all(worktrees.map(async w => {
      try {
        const status = await git(w.path!, ['status', '--porcelain=v1', '-uall']);
        const ignored = (await git(w.path!, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'])).split('\0').filter(Boolean);
        return { ...w, registered: registered.some(r => r.path === w.path && r.branch === w.branch), status: status ? status.split('\n') : [], ignored };
      } catch (error) { errors.push(`Cannot inspect worktree ${w.path}: ${error}`); return { ...w, error: String(error), registered: false }; }
    }));
    const heads = list(await git(cwd, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/']));
    const unregistered = heads.map(h => { const [branch, tip] = h.split(' '); return { branch, tip }; })
      .filter(h => h.branch !== 'refs/heads/main' && !registered.some(w => w.branch === h.branch));
    const detached = worktrees.filter(w => !w.branch);
    const materials = await this.materialCommits(cwd, actor);
    const states = new Map<string, Promise<BranchStatus>>();
    const describeBranch = (tip: string) => {
      if (!states.has(tip)) states.set(tip, this.branchStatus(cwd, tip, remote, materials).catch(error => {
        errors.push(`Cannot account for branch tip ${tip}: ${error}`);
        return { state: 'unknown', unique: null, remaining: null };
      }));
      return states.get(tip)!;
    };
    const reports = [];
    const integrated = new Map<string, boolean>();
    for (const w of workspaces) {
      try {
        if (!existsSync(w.path) || realpathSync(await git(w.path, ['rev-parse', '--show-toplevel'])) !== w.path || integrationRepository(w.path).repo !== w.repo || await git(w.path, ['symbolic-ref', '-q', 'HEAD']) !== w.branch) throw new Error('Registered worktree is missing, moved or has switched branch; preserve and review its registration');
        const tip = await git(w.path, ['rev-parse', 'HEAD']);
        const inspected = actualWorktrees.find(tree => tree.path === w.path && tree.branch === w.branch && tree.head === tip);
        if (!inspected || 'error' in inspected) throw new Error(inspected?.error ?? 'Worktree changed during reconciliation; retry');
        const status = inspected.status.join('\n'), ignored = inspected.ignored;
        const delivered = snapshots.filter(d => d.workspace_id === w.id);
        const valid = delivered.filter(d => this.db.prepare("SELECT 1 FROM handoff_task_events e WHERE e.kind='complete' AND json_extract(e.data_json,'$.deliveryId')=? AND NOT EXISTS(SELECT 1 FROM handoff_task_events later WHERE later.task_id=e.task_id AND later.kind IN ('reopen','cancel') AND later.seq>e.seq)").get(String(d.id)));
        const approved = new Set(valid.flatMap(d => JSON.parse(String(d.commits_json)) as string[]));
        const closeout = await describeBranch(tip);
        const undelivered = closeout.remaining?.filter(c => !approved.has(c)) ?? null;
        const pending = valid.filter(d => {
          if (!remote) return true;
          const tip = String(d.tip);
          if (!integrated.has(tip)) integrated.set(tip, this.contains(cwd, tip, remote));
          return !integrated.get(tip);
        }).map(d => String(d.id));
        const tasks = w.tasks.map(id => { const task = this.store.read(id, w.owner); return { id, state: task.state }; });
        const blockers = [!remote || closeout.state === 'unknown' ? 'remote-incomplete' : '', closeout.remaining?.length ? 'branch-not-integrated' : '', pending.length ? 'pending-deliveries' : '', status ? 'uncommitted-files' : '', ignored.length ? 'ignored-data-needs-preservation' : '', tasks.some(t => t.state !== 'closed' && t.state !== 'cancelled') ? 'open-tasks' : ''].filter(Boolean);
        reports.push({ workspace: w, tip, closeout, status: status ? status.split('\n') : [], ignored, undelivered, pendingDeliveries: pending, tasks, blockers, eligibleForRetirement: blockers.length === 0 });
      } catch (error) { errors.push(`${w.id}: ${error}`); reports.push({ workspace: w, error: String(error), eligibleForRetirement: false }); }
    }
    const localMain = await git(cwd, ['rev-parse', 'refs/heads/main']).catch(() => null);
    const mainDifference = remote && localMain ? (await git(cwd, ['rev-list', '--left-right', '--count', `${localMain}...${remote}`])).split(/\s+/).map(Number) : null;
    const mainTree = actualWorktrees.find(w => w.branch === 'refs/heads/main');
    let mainReason: string | null = !remote ? 'Remote query incomplete' : !localMain ? 'Local main missing' : mainDifference?.[0] ? 'Local main has unique commits; manual review required' : null;
    if (!mainReason && mainDifference?.[1] && mainTree) {
      if ('error' in mainTree) mainReason = mainTree.error!;
      else mainReason = mainGitOperation(mainTree.path!);
    }
    const lastSyncRow = this.db.prepare('SELECT result_json,at FROM handoff_main_sync_results WHERE repo=?').get(target.repo);
    const lastSync = lastSyncRow ? { ...JSON.parse(String(lastSyncRow.result_json)), at: String(lastSyncRow.at) } : null;
    if (!mainReason && mainDifference?.[1] && lastSync?.main === localMain && lastSync?.remote === remote && lastSync?.state === 'blocked') mainReason = lastSync.reason;
    const localMainStatus = { head: localMain, remote, difference: mainDifference, state: mainReason ? 'blocked' : mainDifference?.[1] ? 'fast-forward-available' : 'current', reason: mainReason, lastSync };
    const refCommits = new Map<string, Promise<string[] | null>>();
    const describeRef = async (tip: string | undefined) => {
      if (!tip || !remote) return null;
      if (!refCommits.has(tip)) refCommits.set(tip, git(cwd, ['rev-list', tip, '--not', remote]).then(list).catch(error => {
        errors.push(`Cannot inspect referenced commits ${tip}: ${error}`); return null;
      }));
      return refCommits.get(tip)!;
    };
    const unknown = await Promise.all(unregistered.map(async b => ({ ...b, unintegrated: await describeRef(b.tip) })));
    const detachedHeads = await Promise.all(detached.map(async w => ({ ...w, unintegrated: await describeRef(w.head) })));
    const remoteRefs = await Promise.all(remoteBranches.map(async row => { const [tip, branch] = row.split(/\s+/); return { tip, branch, unintegrated: await describeRef(tip) }; }));
    const jobs = this.db.prepare(`SELECT j.id,j.task_id,j.delivery_id,j.state,j.main_commit,j.note FROM handoff_integrations j JOIN handoff_tasks t ON t.id=j.task_id
      WHERE j.target_key=? ${actor ? 'AND (t.creator=? OR t.assignee=?)' : ''} ORDER BY j.rowid`).all(target.targetKey, ...(actor ? [actor,actor] : []));
    const branches = await Promise.all(heads.map(async row => {
      const [branch, tip] = row.split(' '), status = await describeBranch(tip);
      return { branch, tip, state: status.state, uniqueCommits: status.unique?.length ?? null, unaccountedCommits: status.remaining?.length ?? null,
        worktree: worktrees.find(w => w.branch === branch)?.path ?? null };
    }));
    const archivedBranches = this.db.prepare(`SELECT branch,tip,ref FROM handoff_branch_retirements WHERE repo=? ${actor ? 'AND actor=?' : ''} ORDER BY rowid`).all(target.repo, ...(actor ? [actor] : []));
    const report = { complete: errors.length === 0, remote, mainDifference, localMainStatus, outsideQueue: outside, policy: this.policy(target.targetKey), workspaces: reports,
      branches, archivedBranches, actualWorktrees, unregistered: unknown, detached: detachedHeads, remoteBranches: remoteRefs, jobs, errors };
    if (actor) {
      const digest = createHash('sha256').update(JSON.stringify(report)).digest('hex');
      const previous = this.db.prepare('SELECT digest FROM handoff_reconcile_observations WHERE owner=? AND repo=?').get(actor, target.repo);
      this.db.prepare('INSERT INTO handoff_reconcile_observations VALUES(?,?,?,?) ON CONFLICT(owner,repo) DO UPDATE SET digest=excluded.digest,report_json=excluded.report_json').run(actor, target.repo, digest, JSON.stringify(report));
      return { ...report, changed: previous?.digest !== digest };
    }
    return report;
  }
  async syncMain(cwd: string) {
    const target = integrationRepository(cwd), owner = randomUUID();
    const claimed = this.transaction(() => {
      const lock = this.db.prepare('SELECT pid FROM handoff_main_sync_locks WHERE repo=?').get(target.repo);
      if (lock && alive(Number(lock.pid))) return false;
      this.db.prepare('INSERT INTO handoff_main_sync_locks VALUES(?,?,?) ON CONFLICT(repo) DO UPDATE SET owner=excluded.owner,pid=excluded.pid').run(target.repo, owner, process.pid);
      return true;
    });
    if (!claimed) return { state: 'busy', reason: 'Another local main synchronization is already running; other work can continue' };
    try {
      const result = await this.fastForwardMain(cwd);
      this.db.prepare('INSERT INTO handoff_main_sync_results VALUES(?,?,?) ON CONFLICT(repo) DO UPDATE SET result_json=excluded.result_json,at=excluded.at').run(target.repo, JSON.stringify(result), new Date().toISOString());
      return result;
    } finally {
      this.db.prepare('DELETE FROM handoff_main_sync_locks WHERE repo=? AND owner=?').run(target.repo, owner);
    }
  }
  private async fastForwardMain(cwd: string) {
    const target = integrationRepository(cwd), remote = await this.remoteHead(cwd);
    if (this.policy(target.targetKey) && (await this.outsideQueue(cwd, remote)).length) return { state: 'blocked', remote, reason: 'Queue-external main updates require review before synchronization' };
    const main = await git(cwd, ['rev-parse', 'refs/heads/main']);
    if (main === remote) return { state: 'current', main, remote };
    if (!this.contains(cwd, main, remote)) return { state: 'blocked', main, remote, reason: 'Local main diverged; review local-only commits' };
    const trees = (await git(cwd, ['worktree', 'list', '--porcelain', '-z'])).split('\0\0');
    const block = trees.find(b => b.split('\0').includes('branch refs/heads/main'));
    try {
      if (block) {
        const path = block.split('\0').find(l => l.startsWith('worktree '))!.slice(9);
        const operation = mainGitOperation(path);
        if (operation) return { state: 'blocked', main, remote, reason: operation };
        if (await git(path, ['rev-parse', 'HEAD']) !== main || await git(path, ['symbolic-ref', '-q', 'HEAD']) !== 'refs/heads/main') throw new Error('Main worktree changed during synchronization');
        // Never stash/reset/clean. Git refuses overlapping local modifications,
        // untracked files AND ignored files, while preserving unrelated data.
        await git(path, ['-c', 'core.hooksPath=/dev/null', '-c', 'submodule.recurse=false', 'merge', '--ff-only', '--no-autostash', '--no-overwrite-ignore', '--no-edit', remote]);
      } else await git(cwd, ['update-ref', 'refs/heads/main', remote, main]);
    } catch (error) {
      return { state: 'blocked', main, remote, reason: `Git refused safe main synchronization: ${error instanceof Error ? error.message : String(error)}` };
    }
    return { state: 'synced', main: remote, remote, repo: target.repo };
  }
  private contains(cwd: string, a: string, b: string) { try { gitSync(cwd, ['merge-base', '--is-ancestor', a, b]); return true; } catch { return false; } }
  async preserveMaterial(cwd: string, actor: string, taskId: number, commit: string) {
    const task = this.store.read(taskId, actor);
    if (task.requiresIntegration) throw new Error('Code deliveries must be integrated, not archived as materials');
    const tip = await git(cwd, ['rev-parse', '--verify', `${commit}^{commit}`]);
    if (task.commit && await git(cwd, ['rev-parse', '--verify', `${task.commit}^{commit}`]) !== tip) throw new Error('Material commit does not match the task delivery');
    const ref = `refs/pi-cowork/materials/${taskId}/${tip}`;
    const existing = await git(cwd, ['rev-parse', '--verify', ref]).catch(() => null);
    if (existing !== tip) await git(cwd, ['update-ref', ref, tip, '']);
    return { taskId, commit: tip, ref, state: 'preserved-not-integrated' as const };
  }
  private async materialCommits(cwd: string, actor?: string) {
    const result = new Map<string, number>();
    // Check only preserved references. Reading every historical material task
    // spawned two synchronous Git processes per task, even without a ref.
    const refs = list(await git(cwd, ['for-each-ref', '--format=%(refname) %(objectname) %(objecttype)', 'refs/pi-cowork/materials/']));
    const tasks = new Map<number, ReturnType<HandoffStore['read']>>();
    for (const row of refs) {
      const [ref, commit, type] = row.split(' ');
      const match = /^refs\/pi-cowork\/materials\/(\d+)\/([0-9a-f]{40}|[0-9a-f]{64})$/.exec(ref);
      if (!match || type !== 'commit' || match[2] !== commit) continue;
      const id = Number(match[1]);
      const owner = this.db.prepare(`SELECT assignee FROM handoff_tasks WHERE id=? AND requires_integration=0 ${actor ? 'AND (creator=? OR assignee=?)' : ''}`).get(id, ...(actor ? [actor, actor] : []));
      if (!owner) continue;
      if (!tasks.has(id)) tasks.set(id, this.store.read(id, actor ?? String(owner.assignee)));
      const task = tasks.get(id)!;
      if (task.state !== 'closed' || !task.commit) continue;
      try {
        const delivered = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(task.commit) ? task.commit.toLowerCase()
          : await git(cwd, ['rev-parse', '--verify', `${task.commit}^{commit}`]);
        if (delivered === commit) result.set(commit, id);
      } catch { /* Missing or ambiguous deliveries remain unaccounted for. */ }
    }
    return result;
  }
  async branchStatus(cwd: string, tip: string, remote: string | null, materials: Map<string, number>): Promise<BranchStatus> {
    if (!remote) return { state: 'unknown', unique: null, remaining: null };
    const unique = list(await git(cwd, ['rev-list', tip, '--not', remote]));
    if (!unique.length) return { state: 'merged', unique: [], remaining: [] };
    const equivalent = new Set(list(await git(cwd, ['cherry', remote, tip])).filter(line => line.startsWith('- ')).map(line => line.slice(2)));
    const commits = unique.map(commit => ({ commit, state: equivalent.has(commit) ? 'patch-present' : materials.has(commit) ? 'material-preserved' : 'unaccounted', ...(materials.has(commit) ? { taskId: materials.get(commit) } : {}) }));
    const remaining = commits.filter(c => c.state === 'unaccounted').map(c => c.commit);
    return { state: remaining.length ? 'unaccounted' : commits.some(c => c.state === 'material-preserved') ? 'materials-preserved' : 'patches-present', unique, remaining, commits };
  }
  async retireBranch(cwd: string, actor: string, branch: string, expectedTip: string, note: string, materialTasks: number[] = []) {
    if (!branch.startsWith('refs/heads/') || branch === 'refs/heads/main') throw new Error('Only an explicit local task branch can be retired; main is protected');
    await git(cwd, ['check-ref-format', branch]);
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(expectedTip) || !note.trim()) throw new Error('Provide the exact branch tip and a substantive closeout review note');
    const target = integrationRepository(cwd), remote = await this.remoteHead(cwd);
    const workspaces = this.all(target.repo).filter(w => w.branch === branch);
    if (workspaces.some(w => w.owner !== actor)) throw new Error('Another side owns this branch; its owner must close it out');
    if (await git(cwd, ['rev-parse', '--verify', branch]) !== expectedTip) throw new Error('Branch advanced; review its new tip before retirement');
    for (const id of materialTasks) {
      const task = this.store.read(id, actor);
      if (task.requiresIntegration || task.state !== 'closed' || !task.commit) throw new Error('Only accepted, closed material tasks can preserve unmerged commits');
      const commit = await git(cwd, ['rev-parse', '--verify', `${task.commit}^{commit}`]);
      if (!this.contains(cwd, commit, expectedTip)) throw new Error('Material delivery is not part of this branch');
      await this.preserveMaterial(cwd, actor, id, commit);
    }
    const status = await this.branchStatus(cwd, expectedTip, remote, await this.materialCommits(cwd, actor));
    if (status.state === 'unknown' || status.remaining?.length) throw new Error('Branch has unaccounted commits; integrate them or preserve accepted material deliveries first');
    return this.transaction(() => {
      if (gitSync(cwd, ['rev-parse', '--verify', branch]) !== expectedTip) throw new Error('Branch advanced; review its new tip before retirement');
      const trees = gitSync(cwd, ['worktree', 'list', '--porcelain', '-z']).split('\0\0');
      if (trees.some(block => block.split('\0').includes(`branch ${branch}`))) throw new Error('Branch is still checked out; preserve its worktree and use workspace retirement');
      for (const w of this.all(target.repo).filter(w => w.branch === branch)) {
        if (w.owner !== actor || w.state === 'active' && existsSync(w.path)) throw new Error('Active workspace registration must be reconciled by its owner first');
        if (w.tasks.some(id => !['closed', 'cancelled'].includes(this.store.read(id, actor).state))) throw new Error('Branch still has open tasks');
        if (this.db.prepare("SELECT 1 FROM handoff_integrations j JOIN handoff_deliveries d ON d.id=j.delivery_id WHERE d.workspace_id=? AND j.state IN ('queued','running','blocked')").get(w.id)) throw new Error('Branch still has pending integrations');
      }
      const ref = `refs/pi-cowork/retired/branches/${randomUUID()}`;
      gitSync(cwd, ['update-ref', ref, expectedTip, '']);
      // Compare-delete never rewinds a branch that advanced after review.
      gitSync(cwd, ['update-ref', '-d', branch, expectedTip]);
      for (const w of workspaces) {
        if (w.state === 'active') this.db.prepare("UPDATE handoff_workspaces SET state='retired' WHERE id=?").run(w.id);
        this.event(w.id, actor, 'retire-branch', { branch, tip: expectedTip, remote, ref, note, status: status.state });
      }
      this.db.prepare('INSERT INTO handoff_branch_retirements VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(), target.repo, actor, branch, expectedTip, ref, note, JSON.stringify({ remote, ...status }));
      return { branch, tip: expectedTip, state: 'retired', ref, disposition: status.state, remoteBranchRemoved: false };
    });
  }
  async cleanupPlan(cwd: string, actor: string) {
    const report = await this.reconcile(cwd, actor), target = integrationRepository(cwd);
    const registered = this.all(target.repo);
    const branches = report.branches.filter(b => b.branch !== 'refs/heads/main').map(b => {
      const owners = registered.filter(w => w.branch === b.branch);
      const workspace = owners.find(w => w.state === 'active' && w.path === b.worktree);
      const reasons: string[] = [];
      if (!owners.length) reasons.push('未登记归属与任务；由 Agent 核实后登记，或经逐条审查使用 cowork_branch，不批量猜测');
      let action: 'branch' | 'workspace' = 'branch';
      if (!report.remote || b.state === 'unknown') reasons.push('远端或提交证据不完整');
      if (b.unaccountedCommits) reasons.push(`仍有 ${b.unaccountedCommits} 笔未交付或未保全提交`);
      if (owners.some(w => w.owner !== actor)) reasons.push('归属其他侧，须由所属侧收口');
      else for (const w of owners) {
        if (w.tasks.some(id => !['closed', 'cancelled'].includes(this.store.read(id, actor).state))) reasons.push('关联任务尚未关闭');
        if (this.db.prepare("SELECT 1 FROM handoff_integrations j JOIN handoff_deliveries d ON d.id=j.delivery_id WHERE d.workspace_id=? AND j.state IN ('queued','running','blocked')").get(w.id)) reasons.push('仍有待集成交付');
        if (!b.worktree && w.state === 'active' && existsSync(w.path)) reasons.push('原工作树仍存在，须先核对登记');
      }
      if (b.worktree) {
        action = 'workspace';
        if (!workspace || workspace.owner !== actor) reasons.push('检出工作树未登记为本侧所有');
        else {
          const item = report.workspaces.find(w => w.workspace.id === workspace.id);
          if (!report.complete || !item || 'error' in item) reasons.push('工作树对账不完整，保留现场');
          else if (!item.eligibleForRetirement) reasons.push(...(item.blockers ?? []));
          if (b.worktree === dirname(target.repo)) reasons.push('主检出不能删除');
          if (!reasons.length) {
            const occupied = workspaceOccupancy(b.worktree);
            if (occupied) reasons.push(occupied);
            if (this.store.sides().some(s => s.worktree === b.worktree && alive(s.pid))) reasons.push('仍有存活的 Pi 使用工作树');
          }
        }
      }
      return { ...b, owners: [...new Set(owners.map(w => w.owner))], workspaceId: workspace?.id ?? null,
        action, eligible: reasons.length === 0, reasons: [...new Set(reasons)] };
    });
    const materials = await this.materialCommits(cwd, actor);
    const receipts = new Map(report.archivedBranches.map(b => [String(b.ref), String(b.branch)]));
    const archives = list(await git(cwd, ['for-each-ref', '--format=%(refname) %(objectname)',
      'refs/pi-cowork/materials/', 'refs/pi-cowork/retired/', 'refs/pi-cowork/deliveries/'])).map(row => {
      const [ref, tip] = row.split(' ');
      const kind = ref.startsWith('refs/pi-cowork/materials/') ? 'material' : ref.startsWith('refs/pi-cowork/retired/') ? 'retired' : 'delivery';
      return { ref, tip, kind, branch: receipts.get(ref) ?? null, acceptedMaterial: kind === 'material' && materials.has(tip) };
    });
    return { remote: report.remote, branches, archives, remoteBranches: report.remoteBranches,
      errors: report.errors, summary: { active: branches.length, eligible: branches.filter(b => b.eligible).length,
        retained: branches.filter(b => !b.eligible).length, archived: archives.length, remote: report.remoteBranches.filter(b => b.branch !== 'refs/heads/main').length } };
  }
  async cleanup(cwd: string, actor: string, targets: { branch: string; expectedTip: string }[], note: string) {
    if (!note.trim() || note.length > 4000 || !targets.length || targets.length > 50 || new Set(targets.map(t => t.branch)).size !== targets.length ||
      targets.some(t => !t.branch.startsWith('refs/heads/') || t.branch === 'refs/heads/main' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(t.expectedTip))) {
      throw new Error('Provide 1-50 unique local task branches, exact reviewed tips and a cleanup review note; main is protected');
    }
    const plan = await this.cleanupPlan(cwd, actor);
    const results: { branch: string; tip: string; state: 'retired' | 'retained'; reason?: string; ref?: string }[] = [];
    for (const target of targets) {
      try {
        const item = plan.branches.find(b => b.branch === target.branch);
        if (!item || item.tip !== target.expectedTip) throw new Error('Branch changed or disappeared since preview; review again');
        if (!item.eligible) throw new Error(item.reasons.join('; '));
        let ref: string;
        if (item.action === 'workspace') {
          await this.retire(cwd, actor, item.workspaceId!, true, undefined, { branch: item.branch, tip: item.tip });
          ref = `refs/pi-cowork/retired/${item.workspaceId}`;
        } else {
          ref = (await this.retireBranch(cwd, actor, item.branch, item.tip, note)).ref;
        }
        results.push({ branch: item.branch, tip: item.tip, state: 'retired', ref });
      } catch (error) {
        results.push({ branch: target.branch, tip: target.expectedTip, state: 'retained', reason: String(error) });
      }
    }
    return { results, retired: results.filter(r => r.state === 'retired').length,
      retained: results.filter(r => r.state === 'retained').length, remoteBranchesRemoved: false };
  }
  async retire(cwd: string, actor: string, id: string, remove = false, missingTip?: string, reviewed?: { branch: string; tip: string }) {
    const w = this.read(id, actor);
    if (reviewed && (w.state !== 'active' || w.branch !== reviewed.branch || await git(w.path, ['rev-parse', 'HEAD']) !== reviewed.tip)) throw new Error('Workspace changed since cleanup preview; nothing removed');
    if (w.state === 'retired') return w;
    if (missingTip !== undefined) {
      if (remove || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(missingTip)) throw new Error('Missing-worktree retirement requires an exact former commit and remove=false');
      const target = integrationRepository(cwd);
      if (target.repo !== w.repo || target.targetKey !== w.targetKey) throw new Error('Workspace belongs to another repository or target');
      const tip = await git(cwd, ['rev-parse', '--verify', `${missingTip}^{commit}`]);
      const remote = await this.remoteHead(cwd);
      if (!this.contains(cwd, w.base, tip) || !this.contains(cwd, tip, remote)) throw new Error('Former workspace commit must include its base and already be integrated into remote main');
      return this.transaction(() => {
        const current = this.read(id, actor);
        if (current.state === 'retired') return current;
        // This path only retires metadata. A missing path alone never proves
        // that its branch, Git worktree registration or task obligations ended.
        try { lstatSync(w.path); throw new Error('Workspace path still exists; use normal retirement'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        const trees = gitSync(cwd, ['worktree', 'list', '--porcelain', '-z']).split('\0\0');
        if (trees.some(block => { const lines = block.split('\0'); return lines.includes(`worktree ${w.path}`) || lines.includes(`branch ${w.branch}`); })) throw new Error('Git still registers this worktree or branch; preserve and reconcile it first');
        if (list(gitSync(cwd, ['for-each-ref', '--format=%(refname)', w.branch])).includes(w.branch)) throw new Error('Workspace branch still exists; preserve and reconcile it first');
        if (current.tasks.some(taskId => !['closed', 'cancelled'].includes(this.store.read(taskId, actor).state))) throw new Error('Workspace still has open tasks; retirement refused');
        const deliveries = this.db.prepare('SELECT tip FROM handoff_deliveries WHERE workspace_id=?').all(id);
        if (deliveries.some(d => !this.contains(cwd, String(d.tip), tip))) throw new Error('Former workspace commit does not include every preserved delivery');
        if (this.db.prepare("SELECT 1 FROM handoff_integrations j JOIN handoff_deliveries d ON d.id=j.delivery_id WHERE d.workspace_id=? AND j.state IN ('queued','running','blocked')").get(id)) throw new Error('Workspace still has pending integrations; retirement refused');
        gitSync(cwd, ['update-ref', `refs/pi-cowork/retired/${id}`, tip, '']);
        this.db.prepare("UPDATE handoff_workspaces SET state='retired' WHERE id=? AND state='active'").run(id);
        this.event(id, actor, 'retire', { tip, remote, missing: true, removed: false });
        return this.read(id, actor);
      });
    }
    const report = await this.reconcile(cwd, actor), item = report.workspaces.find(r => r.workspace.id === id);
    if (!report.complete || !item?.eligibleForRetirement || !('tip' in item)) throw new Error('Workspace still has unintegrated code, open tasks, files or incomplete evidence; retirement refused');
    const occupied = workspaceOccupancy(w.path);
    if (occupied) throw new Error(occupied);
    const sides = this.store.sides().filter(s => s.worktree === w.path && alive(s.pid));
    if (sides.length) throw new Error('A registered live Pi still owns this worktree; retire from another idle location');
    const tip = item.tip!;
    if (reviewed && tip !== reviewed.tip) throw new Error('Workspace advanced since cleanup preview; nothing removed');
    await git(cwd, ['update-ref', `refs/pi-cowork/retired/${w.id}`, tip]);
    if (await git(w.path, ['rev-parse', 'HEAD']) !== tip || await git(w.path, ['status', '--porcelain=v1', '-uall', '--ignored']) || await git(w.path, ['symbolic-ref', '-q', 'HEAD']) !== w.branch) throw new Error('Workspace changed during retirement; nothing removed');
    if (remove) {
      // Git refuses dirty/locked worktrees. Keep a permanent ref and compare-delete the branch.
      if (w.path === dirname(w.repo)) throw new Error('The main checkout cannot be removed');
      await git(cwd, ['worktree', 'remove', w.path]);
      if ((await git(cwd, ['worktree', 'list', '--porcelain'])).includes(`branch ${w.branch}\n`)) throw new Error('Branch is still checked out; reference retained');
      await git(cwd, ['update-ref', '-d', w.branch, tip]);
    }
    return this.transaction(() => {
      this.db.prepare("UPDATE handoff_workspaces SET state='retired' WHERE id=? AND state='active'").run(id);
      this.event(id, actor, 'retire', { tip, removed: remove });
      return this.read(id, actor);
    });
  }
}
