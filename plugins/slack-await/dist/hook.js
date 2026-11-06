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
function findTs(v, depth = 0) {
  if (depth > 6 || v === null || typeof v !== "object") return null;
  for (const [k, x] of Object.entries(v)) {
    if ((k === "ts" || k === "message_ts") && typeof x === "string" && TS.test(x)) return x;
  }
  for (const x of Object.values(v)) {
    const found = findTs(x, depth + 1);
    if (found) return found;
  }
  return null;
}
function questionTsFromToolResponse(resp) {
  const direct = findTs(resp);
  if (direct) return direct;
  const text = typeof resp === "string" ? resp : JSON.stringify(resp ?? "");
  const m = /\/archives\/[A-Z0-9]+\/p(\d{10})(\d{6})/.exec(text);
  return m ? `${m[1]}.${m[2]}` : null;
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
function writeWatch(dataDir, w) {
  const dir = sessionDir(dataDir, w.sessionKey);
  mkdirSync(dir, { recursive: true, mode: 448 });
  const file = join2(dir, `${w.id}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(w), { mode: 384 });
  renameSync(tmp, file);
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
  const questionTs = questionTsFromToolResponse(input.tool_response);
  const threadTs = input.tool_input.thread_ts ?? questionTs;
  const w = {
    id: deps.newId(),
    sessionKey: sessionKeyFromHook(input),
    channel,
    questionTs,
    threadTs,
    createdAt: now,
    kind: null,
    lastSeenTs: questionTs ?? slackTsFromMs(now - QUESTION_TS_SLACK_SEC * 1e3),
    pending: [],
    lastPendingAt: null,
    nextPollAt: now
  };
  writeWatch(deps.dataDir, w);
  const where = input.tool_input.thread_ts ? "thread" : channel.startsWith("D") ? "DM" : "conversation";
  return context(
    `slack-await: watching ${where} ${channel} for replies (watch ${w.id}, session ${w.sessionKey}). Do not poll Slack yourself; end the turn when you are waiting.`
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
