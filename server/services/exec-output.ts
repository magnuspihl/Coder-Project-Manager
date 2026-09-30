/**
 * Pure helpers for turning a failed command's stdout/stderr into the text that
 * goes into a user-facing error message (see buildExecError in claude.ts).
 */

/**
 * Lines emitted by the `coder` CLI itself rather than by the command we ran.
 * They carry no diagnostic value and are actively misleading: a plain git
 * conflict surfaces as `Encountered an error running "coder ssh"`, which is what
 * made failing git steps look like Coder outages.
 */
const CODER_NOISE = [
  /^Encountered an error running "coder ssh"/,
  /^error: run command: Process exited with status \d+/,
  /^==> ⧗ /,
  /^⧗ /,
];

/**
 * Extra `coder ssh` chatter that only ever arrives on **stderr**. When any of a
 * workspace's startup scripts has failed, `coder ssh` replays that workspace's
 * entire startup log (`<timestamp> <script name>: …` lines) on every single
 * call. That dump easily runs to 10KB+, and used to push the remote command's
 * real error out of the message entirely. The timestamp pattern is applied to
 * stderr only: the remote command's own output (stdout, under the PTY) could
 * legitimately contain timestamped lines.
 */
const CODER_STDERR_NOISE = [
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?Z /,
  /^=== [✔✘] Running workspace agent startup scripts/,
  /^Warning: A startup script exited with an error/,
  /^For more information and troubleshooting, see https:\/\/coder\.com\/docs/,
  /^Version mismatch: client v/,
  /^download v\S+ with: /,
];

/** Strip PTY decoration (ANSI escapes, CR) and coder-CLI noise from command output. */
export function scrubExecOutput(s: string, stream: 'stdout' | 'stderr' = 'stdout'): string {
  const noise = stream === 'stderr' ? [...CODER_NOISE, ...CODER_STDERR_NOISE] : CODER_NOISE;
  return s
    // OSC (ESC ] … BEL/ST) first, then CSI/other ESC-introduced sequences, then lone ESC.
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, '')
    .replace(/\u001b[@-_][0-?]*[ -\/]*[@-~]?/g, '')
    .replace(/\u001b/g, '')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() && !noise.some((re) => re.test(l)))
    .join('\n')
    .trim();
}

/** Keep the last `max` characters of `s`, marking the cut with a leading "…". */
function tail(s: string, max: number): string {
  return s.length > max ? `…${s.slice(-max)}` : s;
}

/**
 * Scrub and join stdout and stderr, fitting the result into `limit` characters.
 *
 * Each stream is tail-truncated against its own share of the budget, not the
 * joined string: taking the tail of `stdout + stderr` lets a long stderr evict
 * stdout completely — and under `coder ssh` stdout is where the remote command's
 * actual error lives. Each stream is guaranteed half the budget, and a stream
 * that needs less hands the rest to the other.
 */
export function combineExecOutput(stdout: string, stderr: string, limit: number): string {
  const out = scrubExecOutput(stdout, 'stdout');
  const err = scrubExecOutput(stderr, 'stderr');
  if (out.length + err.length <= limit) return [out, err].filter(Boolean).join('\n');
  const half = Math.floor(limit / 2);
  const outBudget = err.length < half ? limit - err.length : Math.max(half, limit - err.length);
  const errBudget = limit - Math.min(out.length, outBudget);
  return [tail(out, outBudget), tail(err, errBudget)].filter(Boolean).join('\n');
}

/**
 * Remove credentials from text headed for a task message or a log line.
 *
 * Commands CPM runs carry live bearer tokens inline (`export GH_TOKEN='…'`), and
 * Node's own "Command failed: <command>" message quotes the command verbatim —
 * so without this, a failure with no other output published the user's GitHub
 * token into the task conversation.
 */
export function redactSecrets(s: string): string {
  return s
    // NAME=value assignments for anything named like a credential.
    .replace(
      /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|_PAT))=('[^']*'|"[^"]*"|[^\s'"]+)/g,
      '$1=[REDACTED]',
    )
    // Bare GitHub tokens (classic gho_/ghp_/ghu_/ghs_/ghr_ and fine-grained PATs).
    .replace(/\b(?:gh[opusr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[REDACTED]')
    // Anthropic API / OAuth tokens.
    .replace(/\bsk-ant-[A-Za-z0-9_-]{16,}/g, '[REDACTED]');
}
