import { createInterface } from 'node:readline';
import { SlackAuthError, SlackClient } from './slack.js';
import { closeWatch, listWatches } from './spool.js';
import { readToken, writeToken } from './token.js';

export interface CliDeps {
  out(line: string): void;
  readToken(): string | null;
  writeToken(token: string): 'keychain' | 'file';
  readSecret(prompt: string): Promise<string>;
  authTest(token: string): Promise<{ userId: string; teamId: string }>;
}

const USAGE = [
  'usage: slack-await --data <dir> list --session <key>',
  '       slack-await --data <dir> done <watch-id>',
  '       slack-await --data <dir> cancel <watch-id>',
  '       slack-await setup',
  '       slack-await doctor [--expect-user <slack-user-id>]',
];

const hhmm = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const dataDir = option(argv, '--data');
  const args = argv.filter((a, i) => a !== '--data' && argv[i - 1] !== '--data');
  const [cmd, ...rest] = args;

  switch (cmd) {
    case 'list': {
      const session = option(rest, '--session');
      if (!dataDir || !session) break;
      const watches = listWatches(dataDir, session);
      if (watches.length === 0) deps.out('no watches');
      for (const w of watches) {
        deps.out(
          `${w.id} ${w.kind ?? '?'} ${w.channel} asked ${hhmm(w.createdAt)} ${w.closed ?? 'active'}`,
        );
      }
      return 0;
    }
    case 'done':
    case 'cancel': {
      const id = rest[0];
      if (!dataDir || !id) break;
      const ok = closeWatch(dataDir, id, cmd === 'done' ? 'done' : 'cancelled');
      deps.out(ok ? `closed ${id}` : `no watch ${id}`);
      return ok ? 0 : 1;
    }
    case 'setup': {
      const token = (await deps.readSecret('Slack user token (xoxp-…): ')).trim();
      if (!token.startsWith('xoxp-')) {
        deps.out('expected a user token (xoxp-…)');
        return 2;
      }
      try {
        const { userId } = await deps.authTest(token);
        deps.out(`stored in ${deps.writeToken(token)}; Slack user ${userId}`);
        return 0;
      } catch (e) {
        deps.out(
          e instanceof SlackAuthError
            ? 'Slack rejected this token'
            : `could not check the token: ${(e as Error).message}`,
        );
        return 1;
      }
    }
    case 'doctor': {
      const token = deps.readToken();
      if (!token) {
        deps.out('token: missing');
        return 1;
      }
      let userId: string;
      try {
        userId = (await deps.authTest(token)).userId;
      } catch (e) {
        deps.out(
          e instanceof SlackAuthError
            ? 'token: invalid'
            : `token: unchecked (${(e as Error).message})`,
        );
        return 1;
      }
      deps.out(`token: ok (${userId})`);
      const expected = option(rest, '--expect-user');
      if (expected && expected !== userId) {
        deps.out(`token belongs to ${userId}, Slack connector is ${expected} — refusing`);
        return 3;
      }
      return 0;
    }
  }
  for (const l of USAGE) deps.out(l);
  return 64;
}

function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    return new Promise((resolve) => {
      let s = '';
      process.stdin.on('data', (c) => (s += c));
      process.stdin.on('end', () => resolve(s));
    });
  }
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    // Hide what is typed: only the prompt is ever written.
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
      if (s.includes(prompt)) process.stderr.write(prompt);
    };
    rl.question(prompt, (answer) => {
      process.stderr.write('\n');
      rl.close();
      resolve(answer);
    });
  });
}

if (import.meta.main) {
  runCli(process.argv.slice(2), {
    out: (l) => void process.stdout.write(`${l}\n`),
    readToken: () => readToken(),
    writeToken: (t) => writeToken(t),
    readSecret,
    authTest: (t) => new SlackClient(t).authTest(),
  }).then((code) => {
    process.exitCode = code;
  });
}
