import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const source = import.meta.dirname;
const agent = join(homedir(), ".pi", "agent");
const destination = join(agent, "extensions", "pi-cowork");
const legacyDestination = join(agent, "extensions", "pi-handoff");
const files = ["index.ts", "resume.ts", "channel.ts", "store.ts", "repository.ts", "workspaces.ts", "integration-store.ts", "integration.ts", "types.ts", "ui.ts", "side-panel.ts", "branch-panel.ts", "instructions.ts", "user-notification.ts", "README.md", "package.json"];
const dependencySource = join(source, "node_modules", "typebox");
const checkOnly = process.argv.includes("--check");
const version = JSON.parse(readFileSync(join(source, "package.json"), "utf8")).version;

for (const [path, expected] of [[destination, '@pi/pi-cowork'], [legacyDestination, '@pi/pi-handoff']]) {
  if (!existsSync(path)) continue;
  let installed;
  try { installed = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')); }
  catch { throw new Error(`Cannot identify installed extension at ${path}; preserved`); }
  if (installed.name !== expected) throw new Error(`Unknown package at ${path}; preserved`);
}

function digest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
const mismatches = files.filter(name => !existsSync(join(destination, name)) || digest(join(source, name)) !== digest(join(destination, name)));
if (!existsSync(join(destination, 'node_modules', 'typebox', 'package.json')) || !existsSync(dependencySource)) mismatches.push('node_modules/typebox');
if (checkOnly) {
  const ok = !mismatches.length && !existsSync(legacyDestination);
  console[ok ? 'log' : 'error'](JSON.stringify({ ok, destination, version, mismatches, duplicateInstallation: existsSync(legacyDestination) }, null, 2));
  process.exit(ok ? 0 : 1);
}

// Stage outside the auto-loaded extension directory. The old installation is
// moved out only after every new file and dependency has been copied.
const archive = join(agent, 'state', 'pi-cowork-install-backups');
mkdirSync(archive, { recursive: true, mode: 0o700 });
const staging = mkdtempSync(join(archive, 'staging-'));
const backups = [];
try {
  for (const name of files) cpSync(join(source, name), join(staging, name));
  mkdirSync(join(staging, 'node_modules'), { recursive: true });
  cpSync(dependencySource, join(staging, 'node_modules', 'typebox'), { recursive: true });
  mkdirSync(join(agent, 'extensions'), { recursive: true });
  for (const [path, name] of [[destination, 'pi-cowork'], [legacyDestination, 'pi-handoff']]) {
    if (!existsSync(path)) continue;
    const backup = join(archive, `${name}-${Date.now()}`);
    renameSync(path, backup);
    backups.push({ path, backup });
  }
  renameSync(staging, destination);
} catch (error) {
  for (const { path, backup } of backups.reverse()) if (!existsSync(path)) renameSync(backup, path);
  throw error;
} finally { rmSync(staging, { recursive: true, force: true }); }
console.log(JSON.stringify({
  ok: true, destination, version, archivedInstallations: backups.map(item => item.backup),
  installed: [...files, 'node_modules/typebox'],
  reload: 'Run /reload in each Pi, then use /cowork and cowork_* tools. Existing tasks, identities and history are preserved; old command/tool names are removed.'
}, null, 2));
