import assert from 'node:assert/strict';
import test from 'node:test';
import { loadWithStatus } from '../ui.ts';
import { showBranches } from '../branch-panel.ts';

test('loading status precedes the scan and clears on success and failure', async () => {
  const updates: unknown[] = [];
  const ctx: any = { ui: { setStatus: (key: string, text?: string) => updates.push([key, text]) } };
  let finish!: (value: number) => void;
  const task = loadWithStatus(ctx, '正在加载', () => new Promise<number>(resolve => { finish = resolve; }));
  assert.deepEqual(updates, [['cowork-loading', '正在加载']]);
  finish(42); assert.equal(await task, 42);
  assert.deepEqual(updates.at(-1), ['cowork-loading', undefined]);
  await assert.rejects(loadWithStatus(ctx, '正在加载', async () => { throw new Error('offline'); }), /offline/);
  assert.deepEqual(updates.at(-1), ['cowork-loading', undefined]);
});

test('branch scan errors clear feedback without opening a misleading empty panel', async () => {
  const updates: unknown[] = [];
  const ctx: any = { mode: 'tui', ui: {
    setStatus: (_key: string, text?: string) => updates.push(text),
    custom: () => assert.fail('Do not show an empty successful result'),
  } };
  const ledger: any = { cleanupPlan: async () => { assert.match(String(updates.at(-1)), /正在加载分支/); throw new Error('offline'); } };
  await assert.rejects(showBranches(ctx, ledger, '/repo', 'side'), /offline/);
  assert.equal(updates.at(-1), undefined);
});
