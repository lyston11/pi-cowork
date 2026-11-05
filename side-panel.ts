import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Input, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import type { HandoffStore } from './store.ts';
import type { Side } from './types.ts';

const plain = (value: unknown) => String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
function processStatus(side: Side): string {
  try { process.kill(side.pid, 0); return '进程存活'; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? '已退出' : '无法确认'; }
}

// Human UI only: task counts and side details never enter model tool results.
export async function showSides(ctx: ExtensionContext, store: HandoffStore, self: Side, initialQuery = ''): Promise<boolean> {
  if (ctx.mode !== 'tui') {
    ctx.ui.notify(JSON.stringify(store.sidePage({ query: initialQuery || undefined }), null, 2), 'info');
    return false;
  }
  return ctx.ui.custom<boolean>((tui, theme, _keys, done) => {
    let sides: Side[] = [], nextAfter: string | null = null, total = 0, matched = 0;
    let query = initialQuery.trim(), selected = 0, listOffset = 0, offset = 0, height = 1;
    let view: 'list' | 'detail' | 'confirm' | 'error' = 'list';
    let detail: ReturnType<HandoffStore['sideForHumanUi']> | undefined;
    let notice = '', error = '', editing = false, focused = false;
    const input = new Input({ prompt: '搜索名称/ID: ' });
    const load = (more = false) => {
      const page = store.sidePage({ query: query || undefined, after: more ? nextAfter ?? undefined : undefined, limit: 100 });
      sides = more ? [...sides, ...page.sides] : page.sides;
      ({ nextAfter, total, matched } = page);
      if (!more) { selected = 0; listOffset = 0; }
    };
    const fail = (reason: unknown) => { error = reason instanceof Error ? reason.message : String(reason); view = 'error'; offset = 0; };
    const inspect = () => {
      if (!sides[selected]) return;
      detail = store.sideForHumanUi(sides[selected].id); view = 'detail'; offset = 0;
    };
    const closeSearch = () => { editing = false; input.focused = false; };
    input.onSubmit = value => {
      const next = value.trim();
      if (next.length > 256 || /[\x00-\x1f\x7f]/.test(next)) { notice = '搜索限256字符，不含控制字符'; return; }
      query = next; closeSearch(); notice = ''; load();
    };
    input.onEscape = closeSearch;
    load();
    return {
      get focused() { return focused; },
      set focused(value: boolean) { focused = value; input.focused = value && editing; },
      render(width: number): string[] {
        const frameHeight = Math.max(1, Math.min(tui.terminal.rows - 2, Math.floor(tui.terminal.rows * 0.6)));
        if (width < 12 || frameHeight < 7) return [truncateToWidth('窗口过小；Esc返回', width)];
        const inner = width - 4;
        height = frameHeight - 6;
        const row = (value: string) => {
          const text = truncateToWidth(value, inner);
          return theme.fg('border', '│ ') + text + ' '.repeat(Math.max(0, inner - visibleWidth(text))) + theme.fg('border', ' │');
        };
        const rule = (a: string, b: string) => theme.fg('border', a + '─'.repeat(width - 2) + b);
        let lines: string[], title: string;
        if (view === 'list') {
          title = `项目侧管理 · 已登记 ${total} 侧${query ? ` · 匹配 ${matched} 侧` : ''}`;
          const prefix = height > 1 || editing ? [editing ? input.render(inner)[0] : plain(notice || (query ? `筛选: ${query}` : '历史侧也计入登记数；进程存活不代表正在执行任务'))] : [];
          const visibleCount = Math.max(1, height - prefix.length);
          listOffset = Math.min(listOffset, selected * 2);
          if (selected * 2 >= listOffset + visibleCount) listOffset = selected * 2 - visibleCount + 1;
          const start = Math.floor(listOffset / 2);
          const entries = sides.slice(start, start + Math.ceil((visibleCount + 1) / 2)).flatMap((side, n) => {
            const i = start + n;
            return [
            `${i === selected ? '> ' : '  '}${plain(side.name)}${side.id === self.id ? ' [本侧]' : ''} · ${processStatus(side)}`,
            `  ${plain(side.id)} · ${plain(side.branch)}`,
          ]; });
          lines = [...prefix, ...(entries.length ? entries.slice(listOffset % 2, listOffset % 2 + visibleCount) : ['没有匹配的侧'])];
        } else {
          const side = detail?.side;
          title = view === 'confirm' ? '确认删除侧' : view === 'error' ? '无法完成操作' : `侧详情 · ${plain(side?.name ?? '')}`;
          const body = view === 'error' ? [error, '未删除侧，也未停止进程。Esc返回后可刷新重试。']
            : view === 'confirm' ? [
              `删除 ${side!.name}？`, `侧 ID: ${side!.id}`, `预期会话: ${side!.sessionId}`,
              '仅从目录移除，保留已关闭任务、审计历史、代码和会话文件。',
              '未关闭交接、活动工作区、其他存活进程或续跑消费者会阻止删除。',
              side!.id === self.id ? '本侧须先 /cowork auto off；此操作不会自动暂停续跑。' : '不会强停其他侧的进程。',
              '按 y 确认，Esc 或 n 取消。',
            ] : [
              `名称: ${side!.name}${side!.id === self.id ? ' [本侧]' : ''}`,
              `侧 ID: ${side!.id}`, `会话 ID: ${side!.sessionId}`, `PID: ${side!.pid} · ${processStatus(side!)}`,
              '按 PID 检查，仅表示进程存活，不保证 Agent 正在工作。',
              `工作区: ${side!.worktree}`, `分支: ${side!.branch}`,
              `未关闭交接: ${detail!.openTasks}`, `活动工作区: ${detail!.workspaces}`,
              `自动续跑设置: ${detail!.autoResume.enabled ? '开启' : '暂停'}`,
              `暂停原因: ${detail!.autoResume.reason ?? '无'}`, `未消费事件: ${detail!.autoResume.pendingEvents}`,
              '删除仅注销侧，不删除任务历史或源码；已退出侧不会因删除而重启。',
            ];
          lines = body.flatMap(line => wrapTextWithAnsi(plain(line), inner));
          offset = Math.min(offset, Math.max(0, lines.length - height));
          lines = lines.slice(offset, offset + height);
        }
        const help = editing ? 'Enter搜索 Esc取消'
          : view === 'confirm' ? 'y确认删除 n/Esc取消 ↑↓滚动'
          : view === 'error' ? 'Enter/Esc返回 ↑↓滚动'
          : view === 'detail' ? 'Enter/Esc返回 d删除 ↑↓滚动 PgUp/PgDn翻页 r刷新'
          : `Esc返回 ↑↓选择 Enter详情 /搜索 d删除 r刷新 PgUp/PgDn翻页 Home/End首尾 · 已载 ${sides.length}/${matched}`;
        return [rule('╭','╮'),row(theme.fg('accent', title)),rule('├','┤'),
          ...Array.from({ length: height }, (_, i) => row(lines[i] ?? '')),rule('├','┤'),
          row(theme.fg('dim', view === 'list' && !editing && visibleWidth(help) > inner
            ? (inner >= 35 ? 'Esc返回 ↑↓选择 Enter详情 /搜索 d删除 r刷新' : 'Esc返回 Enter详情 /搜索 d删除') : help)),rule('╰','╯')];
      },
      handleInput(data: string): void {
        try {
          if (editing) { input.handleInput(data); }
          else if (view === 'confirm' && data === 'y') {
            const target = detail!.side;
            store.removeSide(self, target.id, target.sessionId, 'User confirmed deletion in /cowork sides');
            if (target.id === self.id) { done(true); return; }
            notice = `已删除 ${plain(target.name)}；历史保留`; view = 'list'; detail = undefined; load();
          } else if (view === 'error' && (matchesKey(data, Key.escape) || matchesKey(data, Key.enter))) { view = 'list'; offset = 0; load(); }
          else if (view === 'confirm' && (matchesKey(data, Key.escape) || data === 'n')) { view = 'detail'; offset = 0; }
          else if (view === 'detail' && (matchesKey(data, Key.escape) || matchesKey(data, Key.enter))) { view = 'list'; offset = 0; }
          else if (view !== 'list') {
            if (data === 'd' && view === 'detail') { view = 'confirm'; offset = 0; }
            else if (data === 'r' && view === 'detail') inspect();
            else if (matchesKey(data, Key.up)) offset = Math.max(0, offset - 1);
            else if (matchesKey(data, Key.down)) offset++;
            else if (matchesKey(data, Key.pageUp)) offset = Math.max(0, offset - height);
            else if (matchesKey(data, Key.pageDown)) offset += height;
            else if (matchesKey(data, Key.home)) offset = 0;
            else if (matchesKey(data, Key.end)) offset = Number.MAX_SAFE_INTEGER;
            else return;
          } else if (matchesKey(data, Key.escape)) { done(false); return; }
          else if (data === '/') { editing = true; input.setValue(query); input.focused = focused; }
          else if (data === 'r') { notice = ''; load(); }
          else if (matchesKey(data, Key.enter) || data === 'd') { inspect(); if (data === 'd' && detail) view = 'confirm'; }
          else if (matchesKey(data, Key.home)) { selected = 0; }
          else if (matchesKey(data, Key.end)) { while (nextAfter !== null) load(true); selected = Math.max(0, sides.length - 1); }
          else if ([Key.up, Key.down, Key.pageUp, Key.pageDown].some(key => matchesKey(data, key))) {
            const step = matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown) ? Math.max(1, Math.floor((height - 1) / 2)) : 1;
            const down = matchesKey(data, Key.down) || matchesKey(data, Key.pageDown);
            if (down && nextAfter !== null && selected + step >= sides.length) load(true);
            selected = Math.max(0, Math.min(sides.length - 1, selected + (down ? step : -step)));
          } else return;
        } catch (reason) { fail(reason); }
        tui.requestRender();
      },
      invalidate() { input.invalidate(); },
    };
  }, { overlay: true, overlayOptions: { width: '100%', anchor: 'bottom-center', margin: { top:1,right:0,bottom:2,left:0 } } });
}
