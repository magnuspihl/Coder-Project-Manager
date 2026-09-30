/**
 * Pure helpers for telling `gh` exactly which repository a task's PR belongs to.
 */

export interface GitHubRepoSlug {
  owner: string;
  repo: string;
}

/**
 * Parse `owner/repo` out of a github.com remote or web URL (https or ssh form,
 * with or without `.git`). Returns null for anything that isn't github.com —
 * GitHub Enterprise hosts included, which keep relying on `gh`'s own resolution.
 */
export function parseGitHubRepoSlug(url: string | null | undefined): GitHubRepoSlug | null {
  if (!url) return null;
  const m = url.trim().match(/^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return m ? { owner: m[1], repo: m[2] } : null;
}

export interface GhPrTarget {
  /** `OWNER/REPO` to pass as `gh --repo`, or null to leave the choice to `gh`. */
  repo: string | null;
  /** Value for `gh pr create --head` and the branch selector of `gh pr view`. */
  head: string;
}

/**
 * Where the PR for `branch` must be opened.
 *
 * The branch is always pushed to `origin`; the PR goes against `baseUrl`'s repo
 * (`upstream` in fork-PR mode, otherwise `origin` itself). Both have to be spelt
 * out, because `gh` left to itself resolves the base repo from the checkout's
 * remotes — preferring a remote named `upstream` over `origin` — and reads an
 * unqualified `--head` as a branch of that *base* repo. In a fork checkout that
 * asks GitHub for a PR from `upstream:<branch>`, a branch that only exists on
 * the fork, so creation fails. Hence `--repo` always, and `owner:branch` when
 * the branch lives in a different repo from the PR.
 */
export function resolveGhPrTarget(
  branch: string,
  originUrl: string | null | undefined,
  baseUrl?: string | null,
): GhPrTarget {
  const origin = parseGitHubRepoSlug(originUrl);
  // A base remote that isn't github.com must never silently fall back to origin:
  // that would open the PR on the fork instead of the repo it was meant for.
  const base = baseUrl ? parseGitHubRepoSlug(baseUrl) : origin;
  if (!base) return { repo: null, head: branch };
  const crossRepo = !!origin
    && (origin.owner.toLowerCase() !== base.owner.toLowerCase()
      || origin.repo.toLowerCase() !== base.repo.toLowerCase());
  return {
    repo: `${base.owner}/${base.repo}`,
    head: crossRepo ? `${origin!.owner}:${branch}` : branch,
  };
}
