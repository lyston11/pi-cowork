import fs, { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const platforms = ["native", "gotify", "telegram", "ntfy"] as const;
type Platform = typeof platforms[number];

type NotificationAction = {
  required: true;
  tool: "notify_user";
  title: string;
  message: string;
  priority: "high";
  platforms?: Platform[];
};

function notificationSettings(cwd: string): { selected: Platform[]; native: boolean } | undefined {
  let selected: Platform[] = ["native"];
  let native = true;
  try {
    // Read the notification host's existing global/project settings without
    // loading that extension or changing its configuration.
    for (const root of [homedir(), cwd]) {
      let config: any;
      try { config = JSON.parse(readFileSync(join(root, ".unipi", "config", "notify", "config.json"), "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      if (!config || typeof config !== "object" || Array.isArray(config)) return;
      if (config.defaultPlatforms !== undefined) {
        if (!Array.isArray(config.defaultPlatforms) || !config.defaultPlatforms.every((value: unknown) => platforms.includes(value as Platform))) return;
        selected = [...new Set(config.defaultPlatforms)] as Platform[];
      }
      if (config.native?.enabled !== undefined) {
        if (typeof config.native.enabled !== "boolean") return;
        native = config.native.enabled;
      }
    }
    return { selected, native };
  } catch { return; }
}

function notifyOriginPane(message: string): string | undefined {
  const pane = process.env.PEBREL_PANE_ID || process.env.NEBULA_PANE_ID;
  if (!pane || !/^\d+$/.test(pane)) return;
  // OSC 9 is a text notification. Pebrel attaches the originating pane to its
  // click handler; this does not change the Pi bridge's lifecycle or identity.
  const frame = `\x1b]9;${message.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")}\x07`;
  let fd: number | undefined;
  try {
    fd = fs.openSync("/dev/tty", "w");
    fs.writeFileSync(fd, frame);
    return pane;
  } catch {
    // Native Windows consoles have no /dev/tty. Never write an escape sequence
    // into captured tool output or the RPC JSON stream.
    if (process.stdout.isTTY) { process.stdout.write(frame); return pane; }
  } finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch {} } }
}

export async function userRequestNotification(sessionId: string, cwd: string, title: string, message: string): Promise<{
  userNotification?: NotificationAction;
  terminalNotification?: { transport: "pebrel"; paneId: string; submitted: true };
}> {
  const action: NotificationAction = { required: true, tool: "notify_user", title, message, priority: "high" };
  const settings = notificationSettings(cwd);
  let pane: string | undefined;
  try { if (sessionId && settings?.native && settings.selected.includes("native")) pane = notifyOriginPane(`${title}：${message}`); }
  catch { /* Notification failure must not lose an already recorded request. */ }
  if (!pane) return { userNotification: action };
  const remaining = settings!.selected.filter((platform) => platform !== "native");
  return {
    terminalNotification: { transport: "pebrel", paneId: pane, submitted: true },
    ...(remaining.length ? { userNotification: { ...action, platforms: remaining } } : {}),
  };
}
