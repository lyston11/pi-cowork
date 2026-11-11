import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import type { WorkspaceLedger } from './workspaces.ts';
import { loadWithStatus } from './ui.ts';

const plain = (value: unknown) => String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
const dispositions = {
  merged: '已入主线', 'patches-present': '补丁已在主线', 'materials-preserved': '已验收材料，无需合并',
  unaccounted: '仍有未交付内容', unknown: '证据不完整',
};
const reasons: Record<string, string> = {
  'remote-incomplete': '远端查询失败', 'branch-not-integrated': '分支尚有未覆盖提交',
  'pending-deliveries': '仍有待集成交付', 'uncommitted-files': '工作树有未提交文件',
  'ignored-data-needs-preservation': '工作树有 ignored 资料须保留', 'open-tasks': '关联任务尚未关闭',
};

export async function showBranches(ctx: ExtensionContext, ledger: WorkspaceLedger, cwd: string, actor: string): Promise<void> {
  let plan = await loadWithStatus(ctx, 'CoWork：正在加载分支，核对远端与本地…', () => ledger.cleanupPlan(cwd, actor));
  if (ctx.mode !== 'tui') {
    ctx.ui.notify(JSON.stringify({ summary: plan.summary, remote: plan.remote, errors: plan.errors,
      hint: 'Use cowork_cleanup preview with scope=active|archive|remote and follow nextOffset; apply requires exact reviewed branch tips.' }), 'info');
    return;
  }
  await ctx.ui.custom<void>((tui, theme, _keys, done) => {
    let scope: 'active' | 'archive' | 'remote' = 'active';
    let view: 'list' | 'detail' | 'confirm' | 'result' = 'list';
    let selected = 0, offset = 0, height = 1, busy = false, notice = '';
    let body: string[] = [], targets: { branch: string; expectedTip: string }[] = [];
    const entries = () => scope === 'active' ? plan.branches.map(b => ({
      title: `${b.eligible ? '待清理' : '保留'} · ${b.branch.replace('refs/heads/', '')}`,
      summary: `${dispositions[b.state]} · ${b.tip.slice(0, 10)}`,
      detail: [`分支: ${b.branch}`, `提交: ${b.tip}`, `判定: ${dispositions[b.state]}`,
        `远端 main: ${plan.remote ?? '未知'}`, `未覆盖提交: ${b.unaccountedCommits ?? '未知'}`,
        `所属侧: ${b.owners.join(', ') || '未登记'}`, `工作树: ${b.worktree ?? '无检出工作树'}`,
        ...(b.eligible ? [`可清理：${b.action === 'workspace' ? '移除空闲工作树与本地分支' : '移除本地分支'}，保留提交引用。`]
          : b.reasons.map(r => `保留原因: ${reasons[r] ?? r}`)),
        '不会停止进程、删除远端分支或清除归档。'],
    })) : scope === 'archive' ? plan.archives.map(a => ({
      title: a.kind === 'material' ? a.acceptedMaterial ? '已验收材料 · 无需合并' : '材料保全 · 不代表已验收'
        : a.kind === 'retired' ? '已退休 · 提交保留' : '交付快照 · 不代表已集成',
      summary: `${a.branch ?? a.ref} · ${a.tip.slice(0, 10)}`,
      detail: [`保全引用: ${a.ref}`, `提交: ${a.tip}`, ...(a.branch ? [`原分支: ${a.branch}`] : []),
        '归档不是活动分支，不计入待清理数。保全不等于合入主线。',
        '外部 Git 客户端选择“全部引用”时仍可能画出这些线；本面板不修改其过滤设置，也不删除保全引用。'],
    })) : plan.remoteBranches.filter(b => b.branch !== 'refs/heads/main').map(b => ({
      title: `远端保留 · ${b.branch.replace('refs/heads/', '')}`,
      summary: `${b.unintegrated === null ? '证据不完整' : b.unintegrated.length ? `主线外 ${b.unintegrated.length} 笔，需核对` : '已入主线'} · ${b.tip.slice(0, 10)}`,
      detail: [`远端分支: ${b.branch}`, `提交: ${b.tip}`, `主线外提交数: ${b.unintegrated?.length ?? '未知'}`,
        '本入口只清理本地分支与空闲工作树，远端分支明确保留。主线外提交不直接等同漏合并。'],
    }));
    const refresh = async () => { plan = await ledger.cleanupPlan(cwd, actor); selected = Math.min(selected, Math.max(0, entries().length - 1)); };
    const run = (fn: () => Promise<void>) => {
      busy = true; tui.requestRender();
      void fn().catch(error => { body = [String(error), '未确认完成的条目须重新核对；不强制清理。']; view = 'result'; offset = 0; })
        .finally(() => { busy = false; tui.requestRender(); });
    };
    const confirm = (all: boolean) => {
      if (scope !== 'active') return;
      const candidates = all ? plan.branches.filter(b => b.eligible).slice(0, 50) : [plan.branches[selected]].filter(b => b?.eligible);
      if (!candidates.length) { notice = '没有可安全清理的条目；Enter 查看保留原因'; return; }
      targets = candidates.map(b => ({ branch: b.branch, expectedTip: b.tip }));
      body = [`本批清理 ${targets.length} 条（每批最多 50 条），其余保留。`,
        '执行前重新核对提交、任务、归属、文件和占用；变动或失败逐项保留，不影响其他可清理条目。',
        '保留原提交引用；不停止进程，不删除远端分支，不修改 main。',
        ...candidates.flatMap(b => [`${b.branch} @ ${b.tip}`, `  ${b.worktree ? `同时移除空闲工作树: ${b.worktree}` : '仅删除本地分支名'}`]),
        '按 y 确认；n/Esc 取消。'];
      view = 'confirm'; offset = 0;
    };
    return {
      render(width: number): string[] {
        const frame = Math.max(1, Math.min(tui.terminal.rows - 2, Math.floor(tui.terminal.rows * 0.6)));
        if (width < 12 || frame < 7) return [truncateToWidth('窗口过小；Esc返回', width)];
        const inner = width - 4; height = frame - 6;
        const row = (value: string) => { const s = truncateToWidth(value, inner); return theme.fg('border', '│ ') + s + ' '.repeat(Math.max(0, inner - visibleWidth(s))) + theme.fg('border', ' │'); };
        const rule = (a: string, b: string) => theme.fg('border', a + '─'.repeat(width - 2) + b);
        let lines: string[];
        if (view === 'list') {
          const all = entries();
          const prefix = height > 1 ? [plain(busy ? '正在核对…' : notice || (plan.errors.length ? '有不完整证据；不可确认的条目保持保留' : 'Enter详情 · d清理选中 · c清理已完成分支'))] : [];
          const count = Math.max(1, height - prefix.length);
          offset = Math.min(offset, selected * 2);
          if (selected * 2 >= offset + count) offset = selected * 2 - count + 1;
          const start = Math.floor(offset / 2);
          const rows = all.slice(start, start + Math.ceil((count + 1) / 2)).flatMap((e, i) => [
            `${start + i === selected ? '> ' : '  '}${plain(e.title)}`, `  ${plain(e.summary)}`]);
          lines = [...prefix, ...(rows.length ? rows.slice(offset % 2, offset % 2 + count) : ['暂无条目'])];
        } else {
          const wrapped = body.flatMap(line => wrapTextWithAnsi(plain(line), inner));
          offset = Math.min(offset, Math.max(0, wrapped.length - height));
          lines = wrapped.slice(offset, offset + height);
        }
        const title = view === 'confirm' ? '确认清理已完成分支' : view === 'result' ? '分支清理结果' : view === 'detail' ? '分支收口详情'
          : `${scope === 'active' ? '活动分支' : scope === 'archive' ? '归档记录' : '远端分支'} · 活动 ${plan.summary.active} · 待清理 ${plan.summary.eligible} · 保留 ${plan.summary.retained} · 归档 ${plan.summary.archived} · 远端 ${plan.summary.remote}`;
        const help = busy ? '执行中，请稍候（不停止其他进程）' : view === 'confirm' ? 'y确认 n/Esc取消 ↑↓滚动 PgUp/PgDn翻页'
          : view !== 'list' ? 'Enter/Esc返回 ↑↓滚动 PgUp/PgDn翻页 Home/End首尾'
          : 'Esc返回 Tab活动/归档/远端 ↑↓选择 Enter详情 d清理 c批量 r刷新';
        return [rule('╭', '╮'), row(theme.fg('accent', title)), rule('├', '┤'),
          ...Array.from({ length: height }, (_, i) => row(lines[i] ?? '')), rule('├', '┤'), row(theme.fg('dim', help)), rule('╰', '╯')];
      },
      handleInput(data: string): void {
        if (busy) return;
        if (view === 'confirm' && data === 'y') {
          run(async () => {
            const result = await ledger.cleanup(cwd, actor, targets, 'User confirmed reviewed branch tips in /cowork branches');
            body = [`已清理 ${result.retired} 条 · 保留 ${result.retained} 条 · 远端未删除`,
              ...result.results.flatMap(r => [`${r.state === 'retired' ? '已清理' : '保留'}: ${r.branch}`, `  ${r.ref ?? r.reason}`])];
            view = 'result'; offset = 0;
            // Keep the per-item receipt even when a later refresh cannot reach the remote.
            try { await refresh(); } catch (error) { body.push(`刷新失败: ${error}`); }
          });
        } else if (view !== 'list') {
          if (matchesKey(data, Key.escape) || (view === 'confirm' ? data === 'n' : matchesKey(data, Key.enter))) { view = 'list'; offset = 0; }
          else if (matchesKey(data, Key.up)) offset = Math.max(0, offset - 1);
          else if (matchesKey(data, Key.down)) offset++;
          else if (matchesKey(data, Key.pageUp)) offset = Math.max(0, offset - height);
          else if (matchesKey(data, Key.pageDown)) offset += height;
          else if (matchesKey(data, Key.home)) offset = 0;
          else if (matchesKey(data, Key.end)) offset = Number.MAX_SAFE_INTEGER;
          else return;
        } else if (matchesKey(data, Key.escape)) { done(); return; }
        else if (matchesKey(data, Key.tab)) { scope = scope === 'active' ? 'archive' : scope === 'archive' ? 'remote' : 'active'; selected = offset = 0; notice = ''; }
        else if (data === 'r') run(refresh);
        else if (data === 'c' || data === 'd') confirm(data === 'c');
        else if (matchesKey(data, Key.enter) && entries()[selected]) { body = entries()[selected].detail; view = 'detail'; offset = 0; }
        else if (matchesKey(data, Key.home)) selected = 0;
        else if (matchesKey(data, Key.end)) selected = Math.max(0, entries().length - 1);
        else if ([Key.up, Key.down, Key.pageUp, Key.pageDown].some(k => matchesKey(data, k))) {
          const step = matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown) ? Math.max(1, Math.floor(height / 2)) : 1;
          selected = Math.max(0, Math.min(entries().length - 1, selected + (matchesKey(data, Key.up) || matchesKey(data, Key.pageUp) ? -step : step)));
        } else return;
        tui.requestRender();
      },
      invalidate() {},
    };
  }, { overlay: true, overlayOptions: { width: '100%', anchor: 'bottom-center', margin: { top: 1, right: 0, bottom: 2, left: 0 } } });
}
