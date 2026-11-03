import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const source = import.meta.dirname;
const destination = join(homedir(), ".pi", "agent", "extensions", "pi-handoff");
const files = ["index.ts", "resume.ts", "channel.ts", "store.ts", "types.ts", "ui.ts", "instructions.ts", "README.md", "package.json"];
const dependencySource = join(source, "node_modules", "typebox");
const dependencyDestination = join(destination, "node_modules", "typebox");
const checkOnly = process.argv.includes("--check");
const version = JSON.parse(readFileSync(join(source, "package.json"), "utf8")).version;

function digest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const mismatches = files.filter((name) => {
  const target = join(destination, name);
  return !existsSync(target) || digest(join(source, name)) !== digest(target);
});
if (!existsSync(join(dependencyDestination, "package.json")) || !existsSync(dependencySource)) mismatches.push("node_modules/typebox");

if (checkOnly) {
  if (mismatches.length) {
    console.error(JSON.stringify({ ok: false, destination, mismatches }, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, destination, version }, null, 2));
  process.exit(0);
}

mkdirSync(destination, { recursive: true });
for (const name of files) cpSync(join(source, name), join(destination, name));
rmSync(dependencyDestination, { recursive: true, force: true });
mkdirSync(join(destination, "node_modules"), { recursive: true });
cpSync(dependencySource, dependencyDestination, { recursive: true });
console.log(JSON.stringify({
  ok: true,
  destination,
  installed: [...files, "node_modules/typebox"],
  reload: "Run /reload in each Pi to enable durable handoff event resume; existing records are preserved"
}, null, 2));
