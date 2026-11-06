#!/usr/bin/env node

// src/cli.ts
import { createInterface } from "readline";

// src/slack.ts
var API = "https://slack.com/api/";
var AUTH_ERRORS = /* @__PURE__ */ new Set([
  "invalid_auth",
  "token_revoked",
  "not_authed",
  "account_inactive",
  "token_expired"
]);
var SlackAuthError = class extends Error {
};
var SlackNetworkError = class extends Error {
};
var SlackRateLimitError = class extends Error {
  constructor(retryAfterSec) {
    super(`Slack rate limit, retry after ${retryAfterSec}s`);
    this.retryAfterSec = retryAfterSec;
  }
  retryAfterSec;
};
function toMessage(m) {
  return {
    ts: m.ts,
    ...m.user ? { user: m.user } : {},
    ...m.bot_id ? { botId: m.bot_id } : {},
    ...m.subtype ? { subtype: m.subtype } : {},
    text: m.text ?? "",
    ...m.thread_ts ? { threadTs: m.thread_ts } : {}
  };
}
var SlackClient = class {
  constructor(token, fetchImpl = fetch) {
    this.token = token;
    this.fetchImpl = fetchImpl;
  }
  token;
  fetchImpl;
  names = /* @__PURE__ */ new Map();
  async call(method, params) {
    const url = new URL(method, API);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    let res;
    try {
      res = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${this.token}` } });
    } catch (e) {
      throw new SlackNetworkError(`${method}: ${e.name}`);
    }
    if (res.status === 429) {
      throw new SlackRateLimitError(Number(res.headers.get("retry-after")) || 60);
    }
    if (!res.ok) throw new SlackNetworkError(`${method}: HTTP ${res.status}`);
    let body;
    try {
      body = await res.json();
    } catch {
      throw new SlackNetworkError(`${method}: invalid JSON`);
    }
    if (!body.ok) {
      const err = String(body.error ?? "unknown_error");
      if (AUTH_ERRORS.has(err)) throw new SlackAuthError(`${method}: ${err}`);
      throw new SlackNetworkError(`${method}: ${err}`);
    }
    return body;
  }
  async paged(method, params) {
    const out = [];
    let cursor = "";
    do {
      const body = await this.call(method, {
        ...params,
        limit: "200",
        ...cursor ? { cursor } : {}
      });
      out.push(...body.messages ?? []);
      cursor = body.response_metadata?.next_cursor ?? "";
    } while (cursor);
    return out;
  }
  async authTest() {
    const b = await this.call("auth.test", {});
    return { userId: b.user_id, teamId: b.team_id };
  }
  async conversationKind(channel) {
    const c = (await this.call("conversations.info", { channel })).channel ?? {};
    return c.is_im ? "im" : c.is_mpim ? "mpim" : "channel";
  }
  async history(channel, oldest) {
    const raw = await this.paged("conversations.history", { channel, oldest });
    return raw.map(toMessage).sort((a, b) => Number(a.ts) - Number(b.ts));
  }
  async replies(channel, threadTs, oldest) {
    const raw = await this.paged("conversations.replies", { channel, ts: threadTs, oldest });
    return raw.filter((m) => m.ts !== threadTs).map(toMessage);
  }
  async userName(userId) {
    const cached = this.names.get(userId);
    if (cached) return cached;
    const u = (await this.call("users.info", { user: userId })).user ?? {};
    const name = u.real_name || u.profile?.display_name || userId;
    this.names.set(userId, name);
    return name;
  }
};

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
function closeWatch(dataDir, id, reason) {
  const root = join2(dataDir, "sessions");
  if (!existsSync(root)) return false;
  for (const key of readdirSync(root)) {
    const dir = join2(root, key);
    if (existsSync(join2(dir, `${id}.json`))) {
      writeFileSync(join2(dir, `${id}.${reason}`), "", { mode: 384 });
      return true;
    }
  }
  return false;
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
function keychainWrite(token, d) {
  const r = d.platform === "darwin" ? d.run("security", ["add-generic-password", "-U", "-s", SERVICE, "-a", ACCOUNT, "-w", token]) : d.run(
    "secret-tool",
    ["store", "--label", SERVICE, "service", SERVICE, "account", ACCOUNT],
    token
  );
  return r.status === 0;
}
function readToken(d = realTokenDeps()) {
  const fromKeychain = keychainRead(d);
  if (fromKeychain) return fromKeychain;
  const file = tokenFilePath(d.env);
  if (!existsSync2(file)) return null;
  const v = readFileSync2(file, "utf8").trim();
  return v || null;
}
function writeToken(token, d = realTokenDeps()) {
  if (keychainWrite(token, d) && keychainRead(d) === token) return "keychain";
  const file = tokenFilePath(d.env);
  mkdirSync2(dirname(file), { recursive: true, mode: 448 });
  writeFileSync2(file, `${token}
`, { mode: 384 });
  chmodSync(file, 384);
  return "file";
}

// src/cli.ts
var USAGE = [
  "usage: slack-await --data <dir> list --session <key>",
  "       slack-await --data <dir> done <watch-id>",
  "       slack-await --data <dir> cancel <watch-id>",
  "       slack-await setup",
  "       slack-await doctor [--expect-user <slack-user-id>]"
];
var hhmm = (ms) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
function option(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : void 0;
}
async function runCli(argv, deps) {
  const dataDir = option(argv, "--data");
  const args = argv.filter((a, i) => a !== "--data" && argv[i - 1] !== "--data");
  const [cmd, ...rest] = args;
  switch (cmd) {
    case "list": {
      const session = option(rest, "--session");
      if (!dataDir || !session) break;
      const watches = listWatches(dataDir, session);
      if (watches.length === 0) deps.out("no watches");
      for (const w of watches) {
        deps.out(
          `${w.id} ${w.kind ?? "?"} ${w.channel} asked ${hhmm(w.createdAt)} ${w.closed ?? "active"}`
        );
      }
      return 0;
    }
    case "done":
    case "cancel": {
      const id = rest[0];
      if (!dataDir || !id) break;
      const ok = closeWatch(dataDir, id, cmd === "done" ? "done" : "cancelled");
      deps.out(ok ? `closed ${id}` : `no watch ${id}`);
      return ok ? 0 : 1;
    }
    case "setup": {
      const token = (await deps.readSecret("Slack user token (xoxp-\u2026): ")).trim();
      if (!token.startsWith("xoxp-")) {
        deps.out("expected a user token (xoxp-\u2026)");
        return 2;
      }
      try {
        const { userId } = await deps.authTest(token);
        deps.out(`stored in ${deps.writeToken(token)}; Slack user ${userId}`);
        return 0;
      } catch (e) {
        deps.out(
          e instanceof SlackAuthError ? "Slack rejected this token" : `could not check the token: ${e.message}`
        );
        return 1;
      }
    }
    case "doctor": {
      const token = deps.readToken();
      if (!token) {
        deps.out("token: missing");
        return 1;
      }
      let userId;
      try {
        userId = (await deps.authTest(token)).userId;
      } catch (e) {
        deps.out(
          e instanceof SlackAuthError ? "token: invalid" : `token: unchecked (${e.message})`
        );
        return 1;
      }
      deps.out(`token: ok (${userId})`);
      const expected = option(rest, "--expect-user");
      if (expected && expected !== userId) {
        deps.out(`token belongs to ${userId}, Slack connector is ${expected} \u2014 refusing`);
        return 3;
      }
      return 0;
    }
  }
  for (const l of USAGE) deps.out(l);
  return 64;
}
function readSecret(prompt) {
  if (!process.stdin.isTTY) {
    return new Promise((resolve) => {
      let s = "";
      process.stdin.on("data", (c) => s += c);
      process.stdin.on("end", () => resolve(s));
    });
  }
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    rl._writeToOutput = (s) => {
      if (s.includes(prompt)) process.stderr.write(prompt);
    };
    rl.question(prompt, (answer) => {
      process.stderr.write("\n");
      rl.close();
      resolve(answer);
    });
  });
}
if (import.meta.main) {
  runCli(process.argv.slice(2), {
    out: (l) => void process.stdout.write(`${l}
`),
    readToken: () => readToken(),
    writeToken: (t) => writeToken(t),
    readSecret,
    authTest: (t) => new SlackClient(t).authTest()
  }).then((code) => {
    process.exitCode = code;
  });
}
export {
  runCli
};
