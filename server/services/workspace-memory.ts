import { spawn, execFile } from 'child_process';

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

/**
 * Emit a bash snippet that sets MEMDIR to the workspace's Claude memory dir.
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
