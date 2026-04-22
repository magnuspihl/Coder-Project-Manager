import { spawn } from 'child_process';

const CODER_URL = process.env.CODER_URL || '';

const GUIDELINES_VERSION = 1;
const GUIDELINES_FILENAME = 'cpm_session_guidelines.md';
const VERSION_MARKER = `<!-- cpm-guidelines-version: ${GUIDELINES_VERSION} -->`;
const INDEX_LINE = `- [${GUIDELINES_FILENAME}](${GUIDELINES_FILENAME}) — CPM operating rules for discussion sessions`;

const GUIDELINES_CONTENT = `---
name: cpm-session-guidelines
description: Operating rules for discussion sessions launched by the Coder Project Manager (CPM)
type: reference
---

${VERSION_MARKER}

# CPM Session Guidelines

You are a workspace agent participating in a discussion session launched by the Coder Project Manager (CPM). These rules override anything you would otherwise infer about session etiquette.

## Checkpoint memory frequently — don't defer to end-of-session

Discussion sessions are often **read-only**: Write, Edit, and mutating Bash commands are disabled. One carve-out: you can still write to your own memory directory at \`~/.claude/projects/<encoded-cwd>/memory/\` via Bash (\`mkdir -p\`, \`cat > FILE\`, \`tee\`, etc). Read-only refers to project files and system state, not your own memory.

**Why it matters:** context compaction can fire at any point mid-session. Procedural knowledge that only lives in the live transcript is lost when that happens. Only memory files survive compaction.

**What to do:** save each new fact, decision, or preference as soon as you learn it. Don't batch. Don't wait for a natural stopping point. If the user tells you something that would still be true in a future conversation, write it now — not at the end.

Use the memory types defined in your system prompt (user / feedback / project / reference) and keep \`MEMORY.md\` updated as a one-line-per-entry index.

## Mentioning other workspace agents

Other workspace agents may be participating in this discussion as peers. To pull one into the conversation, include \`[MENTION:<workspace_name>]\` anywhere in your response. CPM routes the message to that agent with catch-up context automatically — you don't need to summarize prior turns for them.

Only mention an agent when there is concrete reason to involve them (e.g. the question genuinely needs their domain, or the user asked). Don't mention an agent just to be thorough.

## Status updates

When you take a non-trivial action, report it via the \`coder_report_task\` tool so the user sees progress in the CPM UI:

- \`state: working\` — actively processing, no user input needed
- \`state: complete\` — finished the current turn's work
- \`state: failure\` — blocked, need user input or hit an error

Keep summaries under 160 characters and make them specific (e.g. \"Reading auth middleware\" beats \"Looking into it\").

## Discussion vs. task queue

A discussion is a conversation, not an implementation session. If the conversation surfaces work that should become a formal task (code changes, a PR, a migration), say so explicitly rather than silently starting the implementation. CPM's host can convert discussion outcomes into queued tasks with full-access sessions — that's the right venue for actual changes.
`;

/**
 * Encode an absolute working-directory path the same way Claude Code does
 * when scoping project memory (e.g. /home/coder/my-project → -home-coder-my-project).
 */
export function encodeWorkingDir(workingDir: string): string {
  return '-' + workingDir.replace(/^\//, '').replace(/\//g, '-');
}

/**
 * Compute the remote agent memory directory for a given absolute working
 * directory. Returns a path containing a literal $HOME for remote expansion.
 */
export function getAgentMemoryDir(workingDir: string): string {
  return `$HOME/.claude/projects/${encodeWorkingDir(workingDir)}/memory`;
}

/** Single-quote a string for safe inclusion in a bash command. */
function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Write the standard CPM session-guidelines memory file to a workspace via SSH.
 *
 * Targets /home/coder/<workspaceName> as the default working directory, with a
 * fallback to /home/coder if that path does not exist on the workspace.
 *
 * Skips the write when the existing file already contains the current version
 * marker, so repeated calls are cheap. Also appends a pointer to MEMORY.md
 * when missing so the agent's index surfaces the guidelines.
 */
export async function writeCpmGuidelines(workspaceName: string): Promise<void> {
  // Coder workspace names: lowercase letters, digits, hyphens. Reject anything
  // else rather than risk shell interpolation on the remote.
  if (!/^[a-zA-Z0-9_-]+$/.test(workspaceName)) {
    console.warn('[cpm-guidelines] Skipping write — unsafe workspace name:', workspaceName);
    return;
  }

  const primaryDir = `/home/coder/${workspaceName}`;
  const fallbackDir = '/home/coder';
  const primaryEncoded = encodeWorkingDir(primaryDir);
  const fallbackEncoded = encodeWorkingDir(fallbackDir);

  // Remote bash script — picks memdir based on whether primaryDir exists,
  // short-circuits if version marker is present, otherwise creates the dir,
  // reads file content from stdin, and maintains the MEMORY.md index.
  const script =
    `set -e\n` +
    `if [ -d ${shellEscape(primaryDir)} ]; then\n` +
    `  MEMDIR="$HOME/.claude/projects/${primaryEncoded}/memory"\n` +
    `else\n` +
    `  MEMDIR="$HOME/.claude/projects/${fallbackEncoded}/memory"\n` +
    `fi\n` +
    `MEMFILE="$MEMDIR/${GUIDELINES_FILENAME}"\n` +
    `if [ -f "$MEMFILE" ] && grep -qF ${shellEscape(VERSION_MARKER)} "$MEMFILE" 2>/dev/null; then\n` +
    `  cat > /dev/null\n` +
    `  exit 0\n` +
    `fi\n` +
    `mkdir -p "$MEMDIR"\n` +
    `cat > "$MEMFILE"\n` +
    `INDEX="$MEMDIR/MEMORY.md"\n` +
    `if [ ! -f "$INDEX" ] || ! grep -qF ${shellEscape(GUIDELINES_FILENAME)} "$INDEX" 2>/dev/null; then\n` +
    `  printf '%s\\n' ${shellEscape(INDEX_LINE)} >> "$INDEX"\n` +
    `fi\n`;

  return new Promise<void>((resolve) => {
    const proc = spawn('coder', ['ssh', workspaceName, '--', script], {
      env: { ...process.env, CODER_URL },
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    proc.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.stdin?.on('error', () => { /* EPIPE when remote short-circuits — ignore */ });

    const timeout = setTimeout(() => {
      proc.kill();
    }, 15000);

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        console.warn(`[cpm-guidelines] write failed on ${workspaceName} (exit ${code}): ${stderr.slice(0, 200)}`);
      }
      resolve();
    });
    proc.on('error', (err) => {
      clearTimeout(timeout);
      console.warn(`[cpm-guidelines] spawn error on ${workspaceName}: ${err.message?.slice(0, 200)}`);
      resolve();
    });

    proc.stdin?.end(GUIDELINES_CONTENT);
  });
}
