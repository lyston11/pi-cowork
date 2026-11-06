import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HANDOFF_RULES, HANDOFF_RUNTIME_RULES, installHandoffRules, withHandoffRules } from "../instructions.ts";

test("AGENTS installation creates or appends static rules exactly once and preserves project content", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-handoff-rules-"));
  try {
    const path = join(root, "AGENTS.md");
    const first = installHandoffRules(root);
    assert.equal(first.changed, true);
    const installed = readFileSync(path, "utf8");
    assert(installed.includes(HANDOFF_RULES));
    assert.doesNotMatch(installed, new RegExp("cowork_identity|侧 ID|恢复原 Pi 会话|SQLite|/reload|Markdown|Trellis|resume-diag|旧通信"));
    assert(HANDOFF_RUNTIME_RULES.includes(HANDOFF_RULES));
    assert(HANDOFF_RUNTIME_RULES.includes("cowork_identity"));
    assert.equal(installHandoffRules(root).changed, false);
    const original = "# Project\n\nExisting branch and authorization rules.\n";
    writeFileSync(path, original);
    installHandoffRules(root);
    const after = readFileSync(path, "utf8");
    assert(after.startsWith(original));
    assert.equal(after.split("<!-- PI-COWORK:START -->").length - 1, 1);
    assert.equal(installHandoffRules(root).changed, false);
    writeFileSync(path, "");
    assert.equal(installHandoffRules(root).changed, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("managed block upgrades leave surrounding bytes and line endings alone", () => {
  const original = "# Before\r\n<!-- PI-HANDOFF:START -->\r\nold rules\r\n<!-- PI-HANDOFF:END -->\r\n# After\r\n";
  const updated = withHandoffRules(original);
  assert(updated.startsWith("# Before\r\n<!-- PI-COWORK:START -->\r\n"));
  assert(updated.endsWith("<!-- PI-COWORK:END -->\r\n# After\r\n"));
  assert.doesNotMatch(updated, /PI-HANDOFF|handoff_list/);
  assert.equal(updated.replace(/\r\n/g, "").includes("\n"), false);
  assert.equal(withHandoffRules(updated), updated);
});

test("event scope keeps summary safeguards and never equates listed with read", () => {
  assert.match(HANDOFF_RULES, /urgent、high、normal 或 low/);
  assert.match(HANDOFF_RULES, /同一状态且条件具备/);
  assert.match(HANDOFF_RULES, /高优先级不解除阻塞/);
  assert.match(HANDOFF_RULES, /userRequest/);
  assert.match(HANDOFF_RULES, /最终回复必须明确告诉用户任务编号/);
  assert.match(HANDOFF_RULES, /不能因收到回复自动解除阻塞/);
  assert.match(HANDOFF_RULES, /摘要分页/);
  assert.match(HANDOFF_RULES, /本轮事件对象、必要依赖/);
  assert.match(HANDOFF_RULES, /首次接触、上下文不足或版本不明/);
  assert.match(HANDOFF_RULES, /不能用上轮已读代替本轮摘要检查/);
  assert.match(HANDOFF_RUNTIME_RULES, /混合事件须覆盖全部指定任务/);
  assert.match(HANDOFF_RUNTIME_RULES, /最近实际读过的 revision/);
  assert.match(HANDOFF_RUNTIME_RULES, /checkpoint 事件要求对消息指定的任务重新 cowork_read/);
  assert.match(HANDOFF_RUNTIME_RULES, /不能以定向事件为由遗漏/);
  assert.match(HANDOFF_RUNTIME_RULES, /不能把“摘要已返回”当作“正文已核对”/);
  assert.doesNotMatch(HANDOFF_RULES, /阅读分配给本侧的待办、待本侧验收的交付/);
});

test("malformed managed blocks fail without overwriting AGENTS", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-handoff-markers-"));
  try {
    const path = join(root, "AGENTS.md");
    for (const invalid of ["before\n<!-- PI-HANDOFF:START -->\ncontent", "<!-- PI-HANDOFF:END -->\n<!-- PI-HANDOFF:START -->", withHandoffRules("") + withHandoffRules(""), "<!-- PI-HANDOFF:START -->\nlegacy\n<!-- PI-HANDOFF:END -->\n" + withHandoffRules("")]) {
      writeFileSync(path, invalid);
      assert.throws(() => installHandoffRules(root), /Malformed or duplicate/);
      assert.equal(readFileSync(path, "utf8"), invalid);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
