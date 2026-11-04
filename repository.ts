import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function gitSync(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] }).trim();
}
export function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((done, fail) => execFile("git", args, { cwd, encoding: "utf8", timeout: 30000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (error, out, stderr) => error ? fail(new Error(stderr || error.message)) : done(out.trim())));
}
export function integrationRepository(cwd: string): { repo: string; url: string; fingerprint: string; targetKey: string } {
  const repo = realpathSync(resolve(cwd, gitSync(cwd, ["rev-parse", "--git-common-dir"])));
  const anchor = gitSync(dirname(repo), ["--git-dir", repo, "rev-parse", "--is-bare-repository"]) === "true" ? repo : dirname(repo);
  const normalize = (value: string) => {
    if (value.startsWith("file://")) return realpathSync(fileURLToPath(value));
    if (isAbsolute(value) || value.startsWith(".") || !value.includes(":") && !value.includes("@")) return realpathSync(resolve(anchor, value));
    return value;
  };
  const fetchUrls = gitSync(anchor, ["--git-dir", repo, "remote", "get-url", "--all", "origin"]).split("\n").map(normalize);
  const pushUrls = gitSync(anchor, ["--git-dir", repo, "remote", "get-url", "--push", "--all", "origin"]).split("\n").map(normalize);
  if (fetchUrls.length !== 1 || pushUrls.length !== 1 || fetchUrls[0] !== pushUrls[0]) throw new Error("Integration requires one origin with the same fetch and push destination");
  let mirror = "";
  try { mirror = gitSync(anchor, ["--git-dir", repo, "config", "--get", "remote.origin.mirror"]); } catch {}
  if (mirror === "true") throw new Error("Mirror remotes cannot be used for integration");
  const url = pushUrls[0];
  let canonical = url;
  if (url.includes("://")) {
    const u = new URL(url);
    if (u.protocol === "ssh:" && (!u.port || u.port === "22") || u.protocol === "https:" && (!u.port || u.port === "443")) canonical = `${u.hostname.toLowerCase()}/${u.pathname.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/, "")}`;
  } else {
    const scp = url.match(/^(?:[^/@:]+@)?([^/:]+):(.+)$/);
    if (scp) canonical = `${scp[1].toLowerCase()}/${scp[2].replace(/\/+$/, "").replace(/\.git$/, "")}`;
  }
  return { repo, url, fingerprint: createHash("sha256").update(url).digest("hex"), targetKey: createHash("sha256").update(`${canonical}\nrefs/heads/main`).digest("hex") };
}
