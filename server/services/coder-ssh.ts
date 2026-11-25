/**
 * argv for `coder ssh <workspace> -- <command...>`. Every CPM call into a
 * workspace goes through here so they all share one set of flags.
 *
 * `--wait=no`: by default (`--wait=auto`) `coder ssh` holds the connection
 * until the workspace's startup scripts have finished. Some templates run
 * scripts for many minutes after a start — Sheets' took 12+ minutes, because
 * one of them runs a whole headless Claude session — and for that entire
 * window every CPM call (staging the MCP config, the port janitor, launching
 * the task) sat silently waiting and then hit its own timeout, failing the
 * task with "timed out after 30000ms". CPM only needs the agent to be
 * connected, not for the template's setup to be done, so connect immediately.
 */
export function coderSshArgs(workspaceName: string, ...command: string[]): string[] {
  return ['ssh', '--wait=no', workspaceName, '--', ...command];
}
