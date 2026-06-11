import { spawn, execFile } from 'child_process';

const CODER_URL = process.env.CODER_URL || '';

const GUIDELINES_VERSION = 2;
const GUIDELINES_FILENAME = 'cpm_guidelines.md';
const VERSION_MARKER = `<!-- cpm-guidelines-version: ${GUIDELINES_VERSION} -->`;
const INDEX_LINE = `- [${GUIDELINES_FILENAME}](${GUIDELINES_FILENAME}) — CPM operating rules for tasks and discussion sessions`;

const GUIDELINES_CONTENT = `---
name: cpm-guidelines
description: Operating rules for CPM-managed sessions (tasks and discussions)
type: reference
---

${VERSION_MARKER}

# CPM Session Guidelines

You are a workspace agent working in a session launched by the Coder Project Manager (CPM).

## Cross-session memory — tasks and discussions share context

This workspace has two session types: **Tasks** (full-access implementation sessions) and **Discussions** (typically read-only conversation sessions). Both session types run in the same workspace directory and **share the same memory directory** (\`~/.claude/projects/<encoded-cwd>/memory/\`).

This means:
- Notes you write during a Task are read automatically at the start of the next Discussion.
- Notes written during a Discussion are read at the start of the next Task.

Use this shared memory to build up workspace knowledge over time: architectural decisions, project conventions, confirmed preferences, non-obvious gotchas.

## Checkpoint memory frequently — don't defer to end-of-session

Context compaction can fire at any point mid-session. Knowledge that only lives in the live transcript is lost when that happens. Only memory files survive compaction.

**What to write:** conventions, decisions, preferences, and gotchas that would still be true in a future session. Do NOT record task-specific findings or things derivable by reading the code.

**How to write:** use Bash (\`mkdir -p\` the memory dir if needed, then write via \`cat >\` or \`tee\`). Use the memory types in your system prompt (user / feedback / project / reference) and keep \`MEMORY.md\` updated as a one-line-per-entry index.

**When to write:** as soon as you learn something worth keeping. Don't batch. Don't wait.

## Discussion sessions: additional rules

In discussion sessions, Write, Edit, and mutating Bash commands are typically disabled for project files. You can still write to your own memory directory via Bash — that is always permitted.

### Mentioning other workspace agents

To pull another agent into the conversation, include \`[MENTION:<workspace_name>]\` anywhere in your response. CPM routes the message to that agent with catch-up context automatically — you don't need to summarize prior turns for them.

Only mention an agent when there is a concrete reason to involve them. Don't mention agents just to be thorough.

### Discussion vs. task queue

A discussion is a conversation, not an implementation session. If the conversation surfaces work that should become formal code changes or a PR, say so explicitly rather than starting the implementation. CPM can convert discussion outcomes into queued Tasks with full-access sessions — that is the right venue for actual changes.

## Status updates

When you take a non-trivial action, report it via the \`coder_report_task\` tool:
- \`state: working\` — actively processing, no user input needed
- \`state: complete\` — finished the current turn's work
- \`state: failure\` — blocked or need user input

Keep summaries under 160 characters and make them specific ("Reading auth middleware" beats "Looking into it").
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
 * Returns the memory directory path (expanded, no $HOME) for a workspace.
 * If projectDir is provided it is used directly (the authoritative path).
 * Otherwise falls back to guessing /home/coder/<workspaceName>, then /home/coder.
 */
function memDirScript(workspaceName: string, projectDir?: string | null): string {
  if (projectDir) {
    const encoded = encodeWorkingDir(projectDir);
    return `MEMDIR="$HOME/.claude/projects/${encoded}/memory"\n`;
  }
  const primaryDir = `/home/coder/${workspaceName}`;
  const fallbackDir = '/home/coder';
  const primaryEncoded = encodeWorkingDir(primaryDir);
  const fallbackEncoded = encodeWorkingDir(fallbackDir);
  return (
    `if [ -d ${shellEscape(primaryDir)} ]; then\n` +
    `  MEMDIR="$HOME/.claude/projects/${primaryEncoded}/memory"\n` +
    `else\n` +
    `  MEMDIR="$HOME/.claude/projects/${fallbackEncoded}/memory"\n` +
    `fi\n`
  );
}

/**
 * Write the unified CPM guidelines memory file to a workspace via SSH.
 *
 * Skips the write when the existing file already contains the current version
 * marker, so repeated calls are cheap (e.g. called before every task launch).
 * Also maintains a pointer in MEMORY.md.
 */
export async function writeCpmGuidelines(workspaceName: string, projectDir?: string | null): Promise<void> {
  if (!/^[a-zA-Z0-9_-]+$/.test(workspaceName)) {
    console.warn('[cpm-guidelines] Skipping write — unsafe workspace name:', workspaceName);
    return;
  }

  const script =
    `set -e\n` +
    memDirScript(workspaceName, projectDir) +
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

    const timeout = setTimeout(() => { proc.kill(); }, 15000);

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

export interface MemoryFile {
  name: string;
  content: string;
}

const FILE_BEGIN = '===BEGIN:';
const FILE_END = '===END:';

/**
 * SSH-read all .md files from the workspace's Claude memory directory.
 * Returns an empty array if the workspace is unreachable or the directory
 * doesn't exist yet.
 */
export async function readWorkspaceMemory(workspaceName: string, projectDir?: string | null): Promise<MemoryFile[]> {
  if (!/^[a-zA-Z0-9_-]+$/.test(workspaceName)) return [];

  const script =
    `set -e\n` +
    memDirScript(workspaceName, projectDir) +
    `if [ ! -d "$MEMDIR" ]; then exit 0; fi\n` +
    `cd "$MEMDIR"\n` +
    `for f in $(ls *.md 2>/dev/null | sort); do\n` +
    `  printf '${FILE_BEGIN}%s===\\n' "$f"\n` +
    `  cat "$f"\n` +
    `  printf '\\n${FILE_END}%s===\\n' "$f"\n` +
    `done\n`;

  return new Promise<MemoryFile[]>((resolve) => {
    execFile('coder', ['ssh', workspaceName, '--', script], {
      env: { ...process.env, CODER_URL },
      timeout: 15000,
      maxBuffer: 1024 * 1024, // 1 MB — memory files should be well under this
    }, (err, stdout) => {
      if (err) {
        resolve([]);
        return;
      }
      const files: MemoryFile[] = [];
      const lines = stdout.split('\n');
      let current: { name: string; lines: string[] } | null = null;
      for (const line of lines) {
        if (line.startsWith(FILE_BEGIN) && line.endsWith('===')) {
          current = { name: line.slice(FILE_BEGIN.length, -3), lines: [] };
        } else if (line.startsWith(FILE_END) && line.endsWith('===')) {
          if (current) {
            // Trim trailing blank line added by printf
            const content = current.lines.join('\n').replace(/\n$/, '');
            files.push({ name: current.name, content });
            current = null;
          }
        } else if (current) {
          current.lines.push(line);
        }
      }
      resolve(files);
    });
  });
}

/**
 * SSH-write a single memory file on the workspace. The filename must end in
 * .md and must not contain path separators.
 */
export async function writeWorkspaceMemoryFile(
  workspaceName: string,
  filename: string,
  content: string,
  projectDir?: string | null,
): Promise<void> {
  if (!/^[a-zA-Z0-9_-]+$/.test(workspaceName)) throw new Error('unsafe workspace name');
  if (!/^[a-zA-Z0-9_.-]+\.md$/.test(filename) || filename.includes('/')) {
    throw new Error('invalid memory filename');
  }

  const script =
    memDirScript(workspaceName, projectDir) +
    `mkdir -p "$MEMDIR"\n` +
    `cat > "$MEMDIR/${filename}"\n`;

  return new Promise<void>((resolve, reject) => {
    const proc = spawn('coder', ['ssh', workspaceName, '--', script], {
      env: { ...process.env, CODER_URL },
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    proc.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.stdin?.on('error', () => { /* EPIPE — ignore */ });

    const timeout = setTimeout(() => { proc.kill(); reject(new Error('SSH timeout')); }, 15000);

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error(`SSH exit ${code}: ${stderr.slice(0, 200)}`));
      else resolve();
    });
    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    proc.stdin?.end(content);
  });
}
