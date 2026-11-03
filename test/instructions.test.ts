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
    assert.doesNotMatch(installed, new RegExp("handoff_identity|侧 ID|恢复原 Pi 会话|SQLite|/reload|Markdown|Trellis|resume-diag|旧通信"));
    assert(HANDOFF_RUNTIME_RULES.includes(HANDOFF_RULES));
    assert(HANDOFF_RUNTIME_RULES.includes("handoff_identity"));
    assert.equal(installHandoffRules(root).changed, false);
    const original = "# Project\n\nExisting branch and authorization rules.\n";
    writeFileSync(path, original);
    installHandoffRules(root);
    const after = readFileSync(path, "utf8");
    assert(after.startsWith(original));
    assert.equal(after.split("<!-- PI-HANDOFF:START -->").length - 1, 1);
    assert.equal(installHandoffRules(root).changed, false);
    writeFileSync(path, "");
    assert.equal(installHandoffRules(root).changed, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("managed block upgrades leave surrounding bytes and line endings alone", () => {
  const original = "# Before\r\n<!-- PI-HANDOFF:START -->\r\nold rules\r\n<!-- PI-HANDOFF:END -->\r\n# After\r\n";
  const updated = withHandoffRules(original);
  assert(updated.startsWith("# Before\r\n<!-- PI-HANDOFF:START -->\r\n"));
  assert(updated.endsWith("<!-- PI-HANDOFF:END -->\r\n# After\r\n"));
  assert.equal(updated.replace(/\r\n/g, "").includes("\n"), false);
  assert.equal(withHandoffRules(updated), updated);
});

test("malformed managed blocks fail without overwriting AGENTS", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-handoff-markers-"));
  try {
    const path = join(root, "AGENTS.md");
    for (const invalid of ["before\n<!-- PI-HANDOFF:START -->\ncontent", "<!-- PI-HANDOFF:END -->\n<!-- PI-HANDOFF:START -->", withHandoffRules("") + withHandoffRules("")]) {
      writeFileSync(path, invalid);
      assert.throws(() => installHandoffRules(root), /Malformed or duplicate/);
      assert.equal(readFileSync(path, "utf8"), invalid);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
