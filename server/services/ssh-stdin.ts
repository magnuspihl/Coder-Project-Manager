import { spawn } from 'child_process';
import type { Readable } from 'stream';

/**
 * Printed by the remote side once its stdin is safe to write to. Distinctive
 * enough that a stray line from the transport can't be mistaken for it.
 */
const READY_MARKER = '__CPM_STDIN_READY__';

/**
 * Feed bytes to a command running inside a workspace, over the SSH session's
 * stdin.
 *
 * Two properties of `coder ssh` shape this, both verified against a live
 * workspace (coder v2.31.7):
 *
 * - **It allocates a PTY for the remote command even when the local stdin is a
 *   pipe** — `tty` on the remote reports /dev/pts/N. A fresh PTY is in canonical
 *   mode with echo on, which buffers input until a newline and interprets
 *   control bytes, so a naive write is not a byte pipe at all. Three live bugs
 *   came from this: a pinned Claude subscription token (no trailing newline) was
 *   never handed to the reader, hanging every remote launch until its timeout —
 *   the reported `Timed out staging the token` failure; binary attachments
 *   killed the session outright on the first 0x03/0x04; and text writes landed
 *   but only after their timeout killed the connection, minus any final line
 *   without a newline. So the remote drops to raw mode before reading and
 *   answers with a ready marker: writing any earlier would race the `stty`, and
 *   whatever landed first would already have been cooked. If `stty` fails
 *   because some future transport gives us no PTY, the marker still arrives and
 *   a plain pipe needs no fixing.
 * - **It does not reliably propagate stdin EOF** (observed: 5+ minute hangs
 *   after the data had fully transferred), so `remoteScript` must consume an
 *   exact byte count — `head -c <byteLength>` — rather than reading to
 *   end-of-stream with `cat`.
 *
 * Throws on timeout, spawn failure, or a non-zero remote exit; the message
 * carries remote stderr when there is any. Callers add their own context.
 */
export async function writeRemoteStdin(opts: {
  workspaceName: string;
  /**
   * Shell to run on the remote. It MUST consume an exact byte count from stdin
   * (see above) — `head -c <bytes>` on every path, including early-exit ones —
   * because EOF alone will not end the read.
   */
  remoteScript: string;
  source: Buffer | Readable;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}): Promise<void> {
  const { workspaceName, remoteScript, source, env, timeoutMs } = opts;
  const wrapped = `stty raw -echo 2>/dev/null; printf %s ${READY_MARKER}; ${remoteScript}`;

  return new Promise<void>((resolve, reject) => {
    const proc = spawn('coder', ['ssh', workspaceName, '--', wrapped], {
      env,
      // stdout must be a pipe (not 'ignore') because the ready marker arrives on
      // it; stderr must be drained or a chatty transport fills the pipe buffer
      // and blocks the child, turning noise into a timeout.
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.kill('SIGKILL');
      reject(err);
    };
    const timer = setTimeout(
      () => fail(new Error(`timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );

    let stderr = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 2000) stderr += chunk.toString();
    });

    let seen = '';
    let ready = false;
    proc.stdout?.on('data', (chunk: Buffer) => {
      if (ready) return; // nothing we need follows the marker; drain and ignore
      seen += chunk.toString();
      if (!seen.includes(READY_MARKER)) {
        // Keep only enough to catch a marker split across chunks.
        seen = seen.slice(-READY_MARKER.length);
        return;
      }
      ready = true;
      proc.stdin.on('error', () => {}); // remote closes stdin once satisfied
      if (Buffer.isBuffer(source)) {
        proc.stdin.end(source);
      } else {
        source.on('error', fail);
        source.pipe(proc.stdin);
      }
    });

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`exit ${code}${stderr.trim() ? `: ${stderr.trim().slice(0, 300)}` : ''}`));
    });
    proc.on('error', fail);
  });
}
