/**
 * The dependency-install shell shared by the task preview (preview.ts) and the
 * review's test-environment pre-check (test-env.ts): which install command a
 * project gets, the marker recording a successful install, and the lock that
 * keeps two installs out of one directory.
 *
 * Deliberately free of imports: review-proof.ts reaches this through
 * test-env.ts, and pulling in the database module from there would make it
 * resolve DATABASE_PATH at import time — before a test has pointed it at a
 * temporary file.
 */

/** Written into node_modules after a successful install: the hash of what was installed. */
export const INSTALL_MARKER = 'node_modules/.cpm-install-ok';

/**
 * Shell: for the project in $PWD, sets CPM_DEPS (the file whose hash decides
 * whether to install), CPM_INSTALL (the command) and CPM_DEPS_HASH. All empty
 * without a package.json. Shared by the preview and the review's dependency
 * pre-check (test-env.ts), so both install the same way and agree on the marker.
 */
export const DETECT_INSTALL_SH = `CPM_DEPS=; CPM_INSTALL=; CPM_DEPS_HASH=
if [ -f package.json ]; then
  if [ -f pnpm-lock.yaml ] && command -v pnpm >/dev/null 2>&1; then
    CPM_DEPS=pnpm-lock.yaml; CPM_INSTALL="pnpm install --frozen-lockfile"
  elif [ -f yarn.lock ] && command -v yarn >/dev/null 2>&1; then
    CPM_DEPS=yarn.lock
    # Yarn Berry (2+) dropped --frozen-lockfile for --immutable.
    YARN_MAJOR=$(yarn --version 2>/dev/null | cut -d. -f1)
    case "$YARN_MAJOR" in ''|*[!0-9]*) YARN_MAJOR=1;; esac
    if [ -f .yarnrc.yml ] || [ "$YARN_MAJOR" -ge 2 ]; then CPM_INSTALL="yarn install --immutable"; else CPM_INSTALL="yarn install --frozen-lockfile"; fi
  elif [ -f package-lock.json ]; then
    CPM_DEPS=package-lock.json; CPM_INSTALL="npm ci"
  else
    CPM_DEPS=package.json; CPM_INSTALL="npm install"
  fi
  CPM_DEPS_HASH="$CPM_DEPS:$(cksum < "$CPM_DEPS" | awk '{print $1"-"$2}')"
fi`;

/**
 * Shell functions serialising dependency installs per directory: the preview's
 * and the review pre-check's. Two installs at once in one tree (npm ci deletes
 * node_modules first) leave it broken for both. `cpm_install_lock <secs>` waits
 * up to that long for the lock on fd 9, then goes ahead regardless; without
 * flock it is a no-op. `cpm_install_unlock` closes fd 9 — it must be called
 * before exec'ing anything long-lived, which would otherwise hold the lock.
 */
export const INSTALL_LOCK_FN = `cpm_install_lock() {
  command -v flock >/dev/null 2>&1 || return 0
  exec 9>"/tmp/cpm-install-$(pwd -P | cksum | cut -d' ' -f1).lock" || return 0
  flock -w "$1" 9 || echo "[cpm] another dependency install in this directory did not finish within $1s; going ahead"
}
cpm_install_unlock() { exec 9>&-; }`;

/**
 * Shell: `cpm_npm_tree_current <deps-file>` succeeds when node_modules already
 * holds exactly what package-lock.json asks for, judged by npm's own record of
 * what it installed (node_modules/.package-lock.json, written at the end of
 * every successful `npm ci` / `npm install`, npm 7+). Every non-optional
 * package in the lockfile must be recorded there at the same version, and its
 * directory must exist.
 *
 * This is how a plain `npm ci` the agent ran itself — which writes no CPM
 * marker — is recognised, so the preview records the marker instead of
 * deleting and re-extracting a correct node_modules. Only npm lockfiles are
 * judged; anything else (pnpm, yarn, no lockfile, no node) is "not known
 * current" and keeps the marker-only behaviour.
 */
export const NPM_TREE_CURRENT_FN = `cpm_npm_tree_current() {
  [ "$1" = package-lock.json ] && [ -f node_modules/.package-lock.json ] || return 1
  command -v node >/dev/null 2>&1 || return 1
  node -e '
const fs = require("fs");
const pk = f => JSON.parse(fs.readFileSync(f, "utf8")).packages;
let want, have;
try { want = pk("package-lock.json"); have = pk("node_modules/.package-lock.json"); } catch (e) { process.exit(1); }
if (!want || !have) process.exit(1);
for (const k of Object.keys(want)) {
  if (!k.startsWith("node_modules/")) continue;
  const w = want[k], h = have[k];
  if (!h) { if (w.optional) continue; process.exit(1); }
  if (h.version !== w.version || !fs.existsSync(k)) process.exit(1);
}' >/dev/null 2>&1
}`;
