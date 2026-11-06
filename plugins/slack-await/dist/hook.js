#!/usr/bin/env node

// src/hook.ts
import { randomBytes } from "crypto";
import { readFileSync as readFileSync3 } from "fs";

// src/constants.ts
var OLD_AFTER_MS = 3 * 36e5;
var EXPIRE_MS = 7 * 864e5;
var QUESTION_TS_SLACK_SEC = 10;

// src/detect.ts
var TS = /^\d{9,}\.\d{6}$/;
var CHANNEL = /^[CDG][A-Z0-9]{6,}$/;
function findKey(v, keys, ok, depth = 0) {
  if (depth > 6 || v === null || typeof v !== "object") return null;
  for (const [k, x] of Object.entries(v)) {
    if (keys.includes(k) && typeof x === "string" && ok.test(x)) return x;
  }
  for (const x of Object.values(v)) {
    const found = findKey(x, keys, ok, depth + 1);
    if (found) return found;
  }
  return null;
}
function parseSentMessage(resp) {
  const text = typeof resp === "string" ? resp : JSON.stringify(resp ?? "");
  const link = /\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})/.exec(text);
  return {
    channel: findKey(resp, ["channel", "channel_id"], CHANNEL) ?? link?.[1] ?? null,
    ts: findKey(resp, ["ts", "message_ts"], TS) ?? (link ? `${link[2]}.${link[3]}` : null)
  };
}
function slackTsFromMs(ms) {
  return `${Math.floor(ms / 1e3)}.${String(ms % 1e3 * 1e3).padStart(6, "0")}`;
}

// src/session.ts
import { createHash } from "crypto";
function toKey(sessionId) {
  return /^[A-Za-z0-9_-]+$/.test(sessionId) ? sessionId : createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
}
function sessionKeyFromHook(input) {
  return toKey(input.session_id);
}

// src/spool.ts
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "fs";
import { join as join2 } from "path";

// src/paths.ts
import { join } from "path";
function sessionDir(dataDir, sessionKey) {
  return join(dataDir, "sessions", sessionKey);
}

// src/spool.ts
var REASONS = ["done", "cancelled"];
function writeWatch(dataDir, w) {
  const dir = sessionDir(dataDir, w.sessionKey);
  mkdirSync(dir, { recursive: true, mode: 448 });
  const file = join2(dir, `${w.id}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(w), { mode: 384 });
  renameSync(tmp, file);
}
function readDirWatches(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(readFileSync(join2(dir, name), "utf8")));
    } catch {
    }
  }
  return out;
}
function closedReason(dir, id) {
  return REASONS.find((r) => existsSync(join2(dir, `${id}.${r}`))) ?? null;
}
function listWatches(dataDir, sessionKey) {
  const dir = sessionDir(dataDir, sessionKey);
  return readDirWatches(dir).map((w) => ({ ...w, closed: closedReason(dir, w.id) }));
}
function readActiveWatches(dataDir, sessionKey) {
  return listWatches(dataDir, sessionKey).filter((w) => w.closed === null).map(({ closed: _closed, ...w }) => w);
}

// src/token.ts
import { spawnSync } from "child_process";
import { chmodSync, existsSync as existsSync2, mkdirSync as mkdirSync2, readFileSync as readFileSync2, writeFileSync as writeFileSync2 } from "fs";
import { homedir } from "os";
import { dirname, join as join3 } from "path";
var SERVICE = "slack-await";
var ACCOUNT = "user-token";
var realTokenDeps = () => ({
  env: process.env,
  platform: process.platform,
  run: (cmd, args, input) => {
    const r = spawnSync(cmd, args, { input, encoding: "utf8", timeout: 1e4 });
    return { status: r.error ? 127 : r.status ?? 1, stdout: r.stdout ?? "" };
  }
});
function tokenFilePath(env = process.env) {
  const base = env.XDG_CONFIG_HOME || join3(env.HOME || homedir(), ".config");
  return join3(base, SERVICE, "token");
}
function keychainRead(d) {
  const r = d.platform === "darwin" ? d.run("security", ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"]) : d.run("secret-tool", ["lookup", "service", SERVICE, "account", ACCOUNT]);
  const v = r.stdout.trim();
  return r.status === 0 && v ? v : null;
}
function readToken(d = realTokenDeps()) {
  const fromKeychain = keychainRead(d);
  if (fromKeychain) return fromKeychain;
  const file = tokenFilePath(d.env);
  if (!existsSync2(file)) return null;
  const v = readFileSync2(file, "utf8").trim();
  return v || null;
}

// src/hook.ts
var SEND_TOOL = /^mcp__.*slack.*__(slack_)?send_message$/i;
function isWatchedSendTool(toolName) {
  return SEND_TOOL.test(toolName) && !/draft|schedule/i.test(toolName);
}
var context = (text) => JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: text } });
function runHook(stdin, deps) {
  let input;
  try {
    input = JSON.parse(stdin);
  } catch {
    return "";
  }
  const channel = input?.tool_input?.channel_id;
  if (!isWatchedSendTool(String(input?.tool_name ?? "")) || !input.session_id || typeof channel !== "string") {
    return "";
  }
  if (!deps.tokenPresent()) {
    return context(
      `slack-await: a reply to this message will NOT wake this session \u2014 no Slack token is set up. Tell the developer to run /slack-await:setup.`
    );
  }
  const now = deps.now();
  const sent = parseSentMessage(input.tool_response);
  const target = /^[UW]/.test(channel) && sent.channel ? sent.channel : channel;
  const sessionKey = sessionKeyFromHook(input);
  const threadTs = input.tool_input.thread_ts ?? sent.ts;
  const cli = `node "${deps.pluginRoot ?? process.env.CLAUDE_PLUGIN_ROOT ?? "<plugin root>"}/dist/cli.js" --data "${deps.dataDir}"`;
  const open = readActiveWatches(deps.dataDir, sessionKey).find(
    (w2) => w2.channel === target && (target.startsWith("D") || w2.threadTs === threadTs)
  );
  const w = open ? { ...open, threadTs: threadTs ?? open.threadTs } : {
    id: deps.newId(),
    sessionKey,
    channel: target,
    questionTs: sent.ts,
    threadTs,
    createdAt: now,
    kind: null,
    lastSeenTs: sent.ts ?? slackTsFromMs(now - QUESTION_TS_SLACK_SEC * 1e3),
    pending: [],
    lastPendingAt: null,
    nextPollAt: now
  };
  writeWatch(deps.dataDir, w);
  const where = input.tool_input.thread_ts ? "thread" : target.startsWith("D") ? "DM" : "conversation";
  return context(
    `slack-await: ${open ? "already watching" : "watching"} ${where} ${target} for replies (watch ${w.id}, session ${sessionKey}). Do not poll Slack yourself; end the turn when you are waiting. When you have used the answer, close the watch: ${cli} done ${w.id} \u2014 list this session's watches: ${cli} list --session ${sessionKey}`
  );
}
var newWatchId = () => `w${BigInt(`0x${randomBytes(5).toString("hex")}`).toString(36).padStart(6, "0").slice(-6)}`;
function main() {
  try {
    const dataDir = process.env.CLAUDE_PLUGIN_DATA;
    if (!dataDir) throw new Error("CLAUDE_PLUGIN_DATA is not set");
    const out = runHook(readFileSync3(0, "utf8"), {
      dataDir,
      now: Date.now,
      tokenPresent: () => readToken() !== null,
      newId: newWatchId
    });
    if (out) process.stdout.write(`${out}
`);
  } catch (e) {
    process.stderr.write(`slack-await hook: ${e.message}
`);
  }
  process.exitCode = 0;
}
if (import.meta.main) main();
export {
  isWatchedSendTool,
  newWatchId,
  runHook
};
