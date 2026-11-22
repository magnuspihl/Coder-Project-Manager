/**
 * Per-workspace test profile: how this repo's tests are run.
 *
 * Precedence — user setting > what the repo says right now > what the implementer
 * last reported. Detection beats the implementer's report because it reflects the
 * tree as it is; the report only fills the gaps detection can't see (a runner the
 * implementer just set up with an unusual command).
 */

import { getDb } from '../db/index.js';
import { explainDetectProfile, parseTestProfile, type TestProfile } from './test-runners.js';

export function getStoredTestProfile(workspaceId: string): TestProfile | null {
  const row = getDb().prepare('SELECT test_profile FROM workspace_settings WHERE workspace_id = ?')
    .get(workspaceId) as { test_profile: string | null } | undefined;
  if (!row?.test_profile) return null;
  try {
    const raw = JSON.parse(row.test_profile) as { source?: string };
    const source = raw.source === 'user' || raw.source === 'implementer' ? raw.source : 'user';
    return parseTestProfile(raw, source);
  } catch {
    return null;
  }
}

export function setStoredTestProfile(workspaceId: string, profile: TestProfile | null): void {
  getDb().prepare(
    `INSERT INTO workspace_settings (workspace_id, test_profile, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(workspace_id) DO UPDATE SET test_profile = excluded.test_profile, updated_at = excluded.updated_at`
  ).run(workspaceId, profile ? JSON.stringify(profile) : null, new Date().toISOString());
}

const PKG_SEPARATOR = '@@CPM_PACKAGE_JSON@@';

/**
 * Work out how to run this workspace's tests, or null when there is no runner we
 * know how to drive (the caller then falls back to opinion-based review).
 * `exec` runs a shell command in the workspace and returns stdout.
 */
export async function resolveTestProfile(
  workspaceId: string,
  worktreePath: string,
  exec: (command: string) => Promise<string>,
): Promise<TestProfile | null> {
  return (await explainTestProfile(workspaceId, worktreePath, exec)).profile;
}

/**
 * `resolveTestProfile`, plus why there is none when there is none — the reason a
 * review falls back to opinion mode, shown as "not test-verified: <reason>".
 */
export async function explainTestProfile(
  workspaceId: string,
  worktreePath: string,
  exec: (command: string) => Promise<string>,
): Promise<{ profile: TestProfile | null; reason?: string }> {
  const stored = getStoredTestProfile(workspaceId);
  if (stored?.source === 'user') return { profile: stored };

  let detected: TestProfile | null = null;
  let reason: string;
  try {
    const wt = `'${worktreePath.replace(/'/g, `'\\''`)}'`;
    const out = await exec(`ls -1A ${wt} 2>/dev/null; echo ${PKG_SEPARATOR}; cat ${wt}/package.json 2>/dev/null`);
    const [listing, pkg] = out.replace(/\r\n?/g, '\n').split(PKG_SEPARATOR);
    const explained = explainDetectProfile({
      rootFiles: listing.split('\n').map(l => l.trim()).filter(Boolean),
      packageJson: pkg?.trim() || null,
    });
    detected = explained.profile;
    reason = explained.reason ?? 'no test runner found';
  } catch (err) {
    // An unreachable workspace shouldn't turn into a confident "no tests here".
    // Fall through to whatever we already know.
    reason = `could not inspect the worktree to find its test runner (${((err as Error)?.message ?? 'unknown error').split('\n')[0].slice(0, 120)})`;
  }
  const profile = detected ?? stored;
  return profile ? { profile } : { profile: null, reason };
}

// ---------------------------------------------------------------------------
// Test obligation (per workspace)
// ---------------------------------------------------------------------------

/** What the workspace setting says. `auto` is the default and is stored as NULL. */
export type TestObligationSetting = 'auto' | 'on' | 'off';

/**
 * What an implementer is actually asked to do:
 *  - `off`      no test obligation, no per-turn test report
 *  - `existing` write tests with the framework the project already has
 *  - `setup`    as above, and set a framework up if there is none
 */
export type TestObligation = 'off' | 'existing' | 'setup';

export function getTestObligationSetting(workspaceId: string): TestObligationSetting {
  const row = getDb().prepare('SELECT test_obligation FROM workspace_settings WHERE workspace_id = ?')
    .get(workspaceId) as { test_obligation: string | null } | undefined;
  return row?.test_obligation === 'on' || row?.test_obligation === 'off' ? row.test_obligation : 'auto';
}

export function setTestObligationSetting(workspaceId: string, setting: TestObligationSetting): void {
  getDb().prepare(
    `INSERT INTO workspace_settings (workspace_id, test_obligation, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(workspace_id) DO UPDATE SET test_obligation = excluded.test_obligation, updated_at = excluded.updated_at`
  ).run(workspaceId, setting === 'auto' ? null : setting, new Date().toISOString());
}

/**
 * The rule. `auto` follows the tooling: a workspace with a supported runner gets
 * the obligation, one without (a Godot or Unity project, say) is left alone
 * rather than having a test framework installed into it. Setting one up is
 * something only an explicit `on` may ask for.
 */
export function decideTestObligation(setting: TestObligationSetting, hasProfile: boolean): TestObligation {
  if (setting === 'off') return 'off';
  if (hasProfile) return 'existing';
  return setting === 'on' ? 'setup' : 'off';
}

/** Setting + (only when needed) a look at the repo. `off` never touches the workspace. */
export async function resolveTestObligation(
  workspaceId: string,
  workDir: string | null,
  exec: (command: string) => Promise<string>,
): Promise<{ obligation: TestObligation; profile: TestProfile | null }> {
  const setting = getTestObligationSetting(workspaceId);
  if (setting === 'off') return { obligation: 'off', profile: null };
  const profile = workDir ? await resolveTestProfile(workspaceId, workDir, exec) : getStoredTestProfile(workspaceId);
  return { obligation: decideTestObligation(setting, !!profile), profile };
}
