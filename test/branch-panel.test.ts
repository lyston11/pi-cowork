import assert from 'node:assert/strict';
import test from 'node:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import { showBranches } from '../branch-panel.ts';

const tip = 'a'.repeat(40);
async function fixture(count = 3) {
  const plan: any = {
    branches: Array.from({ length: count }, (_, i) => ({ branch: `refs/heads/task-${i}`, tip, state: i === 0 ? 'unaccounted' : 'merged',
      eligible: i !== 0, action: 'branch', workspaceId: null, worktree: null, owners: ['b'], unaccountedCommits: i === 0 ? 1 : 0,
      reasons: i === 0 ? ['仍有未交付代码'] : [] })),
    archives: [{ ref: 'refs/pi-cowork/materials/450/abc', tip, kind: 'material', branch: null, acceptedMaterial: true }],
    remoteBranches: [{ branch: 'refs/heads/remote-task', tip, unintegrated: [] }],
    summary: { active: count, eligible: count - 1, retained: 1, archived: 1, remote: 1 }, remote: tip, errors: []
  };
  const calls: any[] = [];
  const ledger: any = {
    cleanupPlan: async () => plan,
    cleanup: async (_cwd: string, _actor: string, targets: any[], note: string) => {
      calls.push({ targets, note });
      return { retired: targets.length - 1, retained: 1, results: targets.map((t, i) => ({ ...t, state: i ? 'retired' : 'retained', ref: i ? 'refs/pi-cowork/retired/test' : undefined, reason: i ? undefined : 'Branch changed since preview' })) };
    }
  };
  const state = { exited: false, renders: 0 };
  const terminal = { rows: 40 }; let panel: any;
  await showBranches({ mode: 'tui', ui: { custom: async (factory: Function) => {
    panel = factory({ terminal, requestRender: () => { state.renders++; } }, { fg: (_c: string, s: string) => s }, null, () => { state.exited = true; });
  } } } as any, ledger, '/repo', 'b');
  return { panel, plan, calls, state, terminal };
}
async function settle(f: Awaited<ReturnType<typeof fixture>>) {
  for (let i = 0; i < 40 && f.panel.render(100).join('\n').includes('执行中'); i++) await new Promise(r => setTimeout(r, 5));
  assert.doesNotMatch(f.panel.render(100).join('\n'), /执行中/);
}

test('branch panel separates active, archive and remote views, with no deletion in read-only tabs', async () => {
  const f = await fixture();
  assert.match(f.panel.render(140).join('\n'), /活动 3.*待清理 2.*保留 1.*归档 1.*远端 1/);
  assert.match(f.panel.render(100).join('\n'), /仍有未交付内容/);
  f.panel.handleInput('\t');assert.match(f.panel.render(100).join('\n'), /归档记录/);
  assert.match(f.panel.render(100).join('\n'), /已验收材料.*无需合并/);
  assert.doesNotMatch(f.panel.render(100).join('\n'), /task-0/);
  f.panel.handleInput('d');f.panel.handleInput('c');f.panel.handleInput('y');assert.equal(f.calls.length,0);
  f.panel.handleInput('\r');assert.match(f.panel.render(100).join('\n'), /不计入待清理数/);
  assert.match(f.panel.render(100).join('\n'), /外部 Git/);
  f.panel.handleInput('\x1b');f.panel.handleInput('\t');assert.match(f.panel.render(100).join('\n'), /远端保留/);
  f.panel.handleInput('d');f.panel.handleInput('y');assert.equal(f.calls.length,0);
});

test('batch cleanup previews exact selected tips, supports cancellation and displays partial results', async () => {
  const f = await fixture();f.panel.handleInput('c');
  const confirmation=f.panel.render(100).join('\n');assert.match(confirmation,/本批清理 2 条/);assert.doesNotMatch(confirmation,/task-0/);
  f.panel.handleInput('n');assert.equal(f.calls.length,0);
  f.panel.handleInput('c');f.plan.branches[1].tip='b'.repeat(40);
  f.panel.handleInput('y');f.panel.handleInput('y');await settle(f);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].targets.length,2);
  assert.equal(f.calls[0].targets[0].expectedTip,tip,'confirmation binds its original exact tip');
  assert.match(f.panel.render(100).join('\n'),/已清理 1 条.*保留 1 条/);
  assert.match(f.panel.render(100).join('\n'),/Branch changed/);
  f.panel.handleInput('\x1b');assert.equal(f.state.exited,false);f.panel.handleInput('\x1b');assert.equal(f.state.exited,true);
});

test('branch panel is bounded and scrollable at small sizes and caps a cleanup batch', async () => {
  const f=await fixture(130);f.terminal.rows=16;f.panel.render(30);f.panel.handleInput('\x1b[F');
  let output=f.panel.render(30);assert(output.length<=16);assert(output.every((l:string)=>visibleWidth(l)<=30));
  assert.match(output.join('\n'),/task-129/);
  f.panel.handleInput('d');assert.match(f.panel.render(100).join('\n'),/本批清理 1 条/);f.panel.handleInput('n');
  f.panel.handleInput('c');assert.match(f.panel.render(100).join('\n'),/本批清理 50 条/);
  f.panel.handleInput('\x1b[F');output=f.panel.render(30);assert(output.length<=16);assert(output.every((l:string)=>visibleWidth(l)<=30));
  f.panel.handleInput('\x1b');assert.equal(f.calls.length,0);f.panel.invalidate();
  f.terminal.rows=8;assert.match(f.panel.render(30).join('\n'),/窗口过小/);f.panel.handleInput('\x1b');assert.equal(f.state.exited,true);
});
