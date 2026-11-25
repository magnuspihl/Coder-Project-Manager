/**
 * Staging a file into a workspace (the MCP config, a pinned subscription token,
 * an attachment) must not wait for the workspace's startup scripts to finish.
 *
 * `coder ssh` waits for them by default, and some templates run scripts for
 * many minutes after a start — so every task created in a freshly started
 * Sheets workspace failed with "Could not stage MCP config on Sheets: timed
 * out after 30000ms". The fake `coder` below behaves like the real one: unless
 * told `--wait=no`, it sits on the connection as if startup scripts were still
 * running; otherwise it runs the remote command locally.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeRemoteStdin } from './ssh-stdin.js';
import { coderSshArgs } from './coder-ssh.js';

const dir = mkdtempSync(join(tmpdir(), 'cpm-ssh-stdin-'));
const bin = join(dir, 'bin');
mkdirSync(bin);
writeFileSync(
  join(bin, 'coder'),
  `#!/bin/bash
# Fake coder CLI: "coder ssh [flags] <workspace> -- <command>"
[ "$1" = ssh ] || exit 2
shift
wait=auto
while [ "$1" != "--" ]; do
  case "$1" in --wait=*) wait="\${1#--wait=}" ;; esac
  shift
done
shift
if [ "$wait" != no ]; then
  echo "==> Running workspace agent startup scripts (non-blocking)" >&2
  exec sleep 60   # startup scripts still running
fi
exec bash -c "$1"
`,
);
chmodSync(join(bin, 'coder'), 0o755);
const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };

after(() => rmSync(dir, { recursive: true, force: true }));

test('every coder ssh call connects without waiting for startup scripts', () => {
  assert.deepEqual(coderSshArgs('Sheets', 'echo hi'), ['ssh', '--wait=no', 'Sheets', '--', 'echo hi']);
  assert.deepEqual(
    coderSshArgs('Sheets', 'find', '/home', '-name', '.git'),
    ['ssh', '--wait=no', 'Sheets', '--', 'find', '/home', '-name', '.git'],
  );
});

test('stages a file on a workspace whose startup scripts are still running', async () => {
  const target = join(dir, 'mcp.json');
  const json = JSON.stringify({ mcpServers: { memory: { type: 'http', url: 'https://example.test/mcp' } } });
  const bytes = Buffer.byteLength(json);
  const started = Date.now();
  await writeRemoteStdin({
    workspaceName: 'Sheets',
    remoteScript: `umask 077; head -c ${bytes} > '${target}'`,
    source: Buffer.from(json),
    env,
    timeoutMs: 10_000,
  });
  assert.ok(Date.now() - started < 10_000, 'finished well before the timeout');
  assert.equal(readFileSync(target, 'utf8'), json);
});
