import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import piCowork from '../index.ts';

test('a Pi started on main freezes the explicitly registered implementation worktree', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-cowork-workspace-tool-'));
  const cwd = process.cwd(), state = process.env.PI_COWORK_STATE_DIR;
  const handlers = new Map<string, Function>();
  const git = (path: string, ...args: string[]) => execFileSync('git', args, { cwd: path, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    const remote = join(root, 'remote.git'), main = join(root, 'main'), implementation = join(root, 'implementation');
    git(root, 'init', '--bare', remote); git(root, 'clone', remote, main);
    git(main, 'switch', '-c', 'main');
    git(main, 'config', '--local', 'pi-cowork.enabled', 'true');
    writeFileSync(join(main, 'README.md'), 'baseline\n'); git(main, 'add', '.');
    git(main, '-c', 'user.name=Pi Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'baseline');
    git(main, 'push', 'origin', 'main');
    git(main, 'worktree', 'add', '-b', 'task/implementation', implementation);
    writeFileSync(join(implementation, 'implementation.txt'), 'actual implementation\n'); git(implementation, 'add', '.');
    git(implementation, '-c', 'user.name=Pi Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'implementation');
    const tip = git(implementation, 'rev-parse', 'HEAD');
    process.chdir(main); process.env.PI_COWORK_STATE_DIR = join(root, 'state');
    const tools = new Map<string, any>();
    piCowork({ registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand() {}, on: (name: string, fn: Function) => handlers.set(name, fn) } as any);
    const execute = (session: string, tool: string, args: unknown) => tools.get(tool).execute('call', args, undefined, undefined, {
      sessionManager: { getSessionId: () => session, getSessionName: () => session }, ui: { notify() {} },
    });
    const owner = (await execute('owner', 'cowork_identity', { name: 'implementation' })).details.self;
    const task = (await execute('creator', 'cowork_create', { to: owner.id, subject: 'Implement', body: 'Use the task worktree', items: ['implementation'], requiresIntegration: true })).details.task;
    const workspace = (await execute('owner', 'cowork_workspace', { action: 'register', path: implementation, tasks: [task.id] })).details.workspace;
    await execute('owner', 'cowork_check', { id: task.id, item: 1, checked: true });
    const done = (await execute('owner', 'cowork_complete', { id: task.id, commit: tip, summary: 'implemented', workspaceId: workspace.id })).details;
    assert.equal(done.delivery.tip, tip);
    assert.equal(done.delivery.workspaceId, workspace.id);
    assert.equal(done.task.state, 'completed');
    assert.notEqual(git(main, 'rev-parse', 'HEAD'), tip);
  } finally {
    await handlers.get('session_shutdown')?.();
    process.chdir(cwd);
    if (state === undefined) delete process.env.PI_COWORK_STATE_DIR; else process.env.PI_COWORK_STATE_DIR = state;
    rmSync(root, { recursive: true, force: true });
  }
});
