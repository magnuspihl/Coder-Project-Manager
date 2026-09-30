import test from 'node:test';
import assert from 'node:assert/strict';
import { combineExecOutput, redactSecrets, scrubExecOutput } from './exec-output.js';

/** What `coder ssh` puts on stderr for a workspace whose startup script failed. */
function startupLogDump(lines: number): string {
  const body = Array.from({ length: lines }, (_, i) =>
    `2026-09-30 17:29:47.${String(i).padStart(3, '0')}Z Claude Code Auto-Start: line ${i} of a long agent transcript`);
  return [
    'Version mismatch: client v2.31.7+a7e9dfa, server v2.37.1+22f4284',
    "download v2.37.1+22f4284 with: 'curl -fsSL https://coder.pihl.family/install.sh | sh'",
    '==> ⧗ Running workspace agent startup scripts (non-blocking)',
    ...body,
    '=== ✘ Running workspace agent startup scripts (non-blocking) [81126ms]',
    'Warning: A startup script exited with an error and your workspace may be incomplete.',
    'For more information and troubleshooting, see https://coder.com/docs/@v2.37.1/admin/templates/troubleshooting',
    'error: run command: Process exited with status 1',
  ].join('\n');
}

const GH_ERROR = 'pull request create failed: GraphQL: Head sha can\'t be blank, Head ref must be a branch (createPullRequest)';

test('a gh error is kept even when coder ssh replays a huge startup log on stderr', () => {
  const out = combineExecOutput(GH_ERROR, startupLogDump(300), 2000);
  assert.ok(out.includes(GH_ERROR), out);
  assert.ok(!out.includes('Claude Code Auto-Start'), out);
});

test('coder startup-log lines are dropped from stderr', () => {
  assert.equal(scrubExecOutput(startupLogDump(5), 'stderr'), '');
});

test('timestamped lines in the command\'s own output are kept', () => {
  const line = '2026-09-30 17:29:47.188Z migration applied';
  assert.equal(scrubExecOutput(line, 'stdout'), line);
});

test('a long stderr cannot push stdout out of the message, and vice versa', () => {
  const stdout = `${'progress\n'.repeat(500)}REAL STDOUT ERROR`;
  const stderr = `${'warning\n'.repeat(500)}REAL STDERR ERROR`;
  const out = combineExecOutput(stdout, stderr, 2000);
  assert.ok(out.includes('REAL STDOUT ERROR'));
  assert.ok(out.includes('REAL STDERR ERROR'));
  assert.ok(out.length <= 2000 + 3, `length ${out.length}`);
});

test('a short stream gives its unused budget to the long one', () => {
  const stdout = 'x'.repeat(5000);
  const out = combineExecOutput(stdout, 'fatal: short', 2000);
  assert.ok(out.endsWith('fatal: short'));
  // stdout gets everything stderr didn't need, not just half.
  assert.ok(out.split('\n')[0].length > 1900);
});

test('output that fits is returned whole', () => {
  assert.equal(combineExecOutput('out', 'err', 2000), 'out\nerr');
  assert.equal(combineExecOutput('', 'err', 2000), 'err');
});

test('GitHub tokens are removed from command lines quoted in errors', () => {
  const token = 'gho_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
  const msg = `Command failed: coder ssh Sheets -- export GH_TOKEN='${token}' TERM=dumb && gh pr create`;
  const red = redactSecrets(msg);
  assert.ok(!red.includes(token), red);
  assert.ok(red.includes("GH_TOKEN=[REDACTED] TERM=dumb && gh pr create"), red);
});

test('bare GitHub and Anthropic tokens are removed wherever they appear', () => {
  const gh = 'ghp_' + 'Z'.repeat(36);
  const pat = 'github_pat_' + '1'.repeat(40);
  const ant = 'sk-ant-oat01-' + 'q'.repeat(40);
  const red = redactSecrets(`token ${gh} then ${pat} and ${ant}.`);
  assert.equal(red, 'token [REDACTED] then [REDACTED] and [REDACTED].');
});

test('credential-named env assignments are redacted but ordinary ones are not', () => {
  assert.equal(
    redactSecrets('CODER_SESSION_TOKEN="abc def" CLAUDE_CODE_OAUTH_TOKEN=xyz NO_COLOR=1'),
    'CODER_SESSION_TOKEN=[REDACTED] CLAUDE_CODE_OAUTH_TOKEN=[REDACTED] NO_COLOR=1',
  );
  // A reference to a variable, not its value, is left alone.
  assert.equal(redactSecrets('printf \':%s\' "$ADO_PAT"'), 'printf \':%s\' "$ADO_PAT"');
});
