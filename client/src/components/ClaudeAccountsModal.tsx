import { useEffect, useState } from 'react';
import {
  getClaudeAccounts,
  createClaudeAccount,
  updateClaudeAccount,
  deleteClaudeAccount,
  verifyClaudeAccount,
  type ClaudeAccount,
  type RateLimitUsage,
  type TokenCheck,
} from '../api/client';

/**
 * Manage the Claude subscription tokens CPM can hand to a task.
 *
 * Without an account here, a task runs on whatever subscription the target
 * workspace is logged into. With one, CPM exports it into the task's shell as
 * CLAUDE_CODE_OAUTH_TOKEN, which the Claude Code CLI prefers over its own login
 * — so the subscription becomes a per-task choice.
 */

type Limits = Record<string, RateLimitUsage>;

/**
 * Compact usage summary — the point of holding two subscriptions is knowing which
 * one has headroom, so show it right next to the account. Usage is attributed per
 * subscription, so these numbers are independent of any workspace.
 */
function UsageSummary({ limits }: { limits: Limits | undefined }) {
  if (!limits) return null;
  const now = Date.now();
  const parts = (['five_hour', 'seven_day'] as const)
    .filter(t => limits[t])
    .map(t => {
      const limit = limits[t];
      const label = t === 'five_hour' ? 'Session' : 'Weekly';
      const pct = Math.round(limit.utilization * 100);
      const diffMs = limit.resetsAt * 1000 - now;
      // 0% with an open window means "seen, but below the reporting threshold".
      const value = pct === 0 && diffMs > 0 ? '<75%' : `${pct}%`;
      let reset = '';
      if (diffMs > 0) {
        const d = Math.floor(diffMs / 86400000);
        const h = Math.floor((diffMs % 86400000) / 3600000);
        const m = Math.floor((diffMs % 3600000) / 60000);
        reset = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
      }
      const hot = pct >= 75;
      return { key: t, text: `${label} ${value}${reset ? ` · resets in ${reset}` : ''}`, hot };
    });

  if (parts.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-x-3 text-xs mt-1">
      {parts.map(p => (
        <span key={p.key} className={p.hot ? 'text-amber-600 dark:text-amber-400' : 'text-gray-500 dark:text-gray-400'}>
          {p.text}
        </span>
      ))}
    </div>
  );
}

export default function ClaudeAccountsModal({ onClose }: { onClose: () => void }) {
  const [accounts, setAccounts] = useState<ClaudeAccount[]>([]);
  const [rateLimits, setRateLimits] = useState<Record<string, Limits>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [label, setLabel] = useState('');
  const [token, setToken] = useState('');
  const [makeDefault, setMakeDefault] = useState(false);
  const [saving, setSaving] = useState(false);

  // Per-account verify results, keyed by account id.
  const [checks, setChecks] = useState<Record<string, TokenCheck | 'pending'>>({});
  // Which account is being edited, and the drafts for it.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [editToken, setEditToken] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);

  const reload = () =>
    getClaudeAccounts()
      .then(({ accounts, rateLimits }) => {
        setAccounts(accounts);
        setRateLimits(rateLimits || {});
      })
      .catch(err => setError(err.message || 'Failed to load accounts'))
      .finally(() => setLoading(false));

  useEffect(() => { reload(); }, []);

  // Close on Escape, matching the app's other overlays. Ignored while editing so
  // Escape cancels the edit first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (editingId) { setEditingId(null); return; }
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, editingId]);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!label.trim() || !token.trim()) return;
    setSaving(true);
    setError('');
    try {
      await createClaudeAccount(label.trim(), token.trim(), makeDefault);
      setLabel('');
      setToken('');
      setMakeDefault(false);
      await reload();
    } catch (err) {
      setError((err as Error).message || 'Failed to add account');
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (account: ClaudeAccount) => {
    setEditingId(account.id);
    setEditLabel(account.label);
    setEditToken('');
    setError('');
  };

  /**
   * Rename and/or rotate the token in place. Rotating matters because the account
   * id is what tasks are pinned to — deleting and re-adding mints a new id and
   * leaves every pinned task unresumable.
   */
  const handleSaveEdit = async (account: ClaudeAccount) => {
    // Blocked rather than ignored: silently discarding a cleared label while
    // saving the token would look like the rename succeeded.
    if (!editLabel.trim()) {
      setError('Label cannot be empty.');
      return;
    }
    const patch: { label?: string; token?: string } = {};
    if (editLabel.trim() !== account.label) patch.label = editLabel.trim();
    if (editToken.trim()) patch.token = editToken.trim();
    if (!patch.label && !patch.token) { setEditingId(null); return; }

    setSavingEdit(true);
    setError('');
    try {
      await updateClaudeAccount(account.id, patch);
      // A rotated token invalidates any previous verify result for this account.
      if (patch.token) setChecks(prev => { const next = { ...prev }; delete next[account.id]; return next; });
      setEditingId(null);
      await reload();
    } catch (err) {
      setError((err as Error).message || 'Failed to save changes');
    } finally {
      setSavingEdit(false);
    }
  };

  const handleVerify = async (id: string) => {
    setChecks(prev => ({ ...prev, [id]: 'pending' }));
    try {
      const result = await verifyClaudeAccount(id);
      setChecks(prev => ({ ...prev, [id]: result }));
    } catch (err) {
      setChecks(prev => ({ ...prev, [id]: { ok: false, status: 'unknown', detail: (err as Error).message } }));
    }
  };

  /**
   * Set or clear the default account.
   *
   * Clearing has to be reachable: with a default set, every task that doesn't name
   * a subscription explicitly — MCP `create_task`, task-request approval — is
   * pinned to it. Without a way back, the only route to "use the workspace's own
   * login by default" would be deleting the account outright, which breaks every
   * task already pinned to it.
   */
  const handleToggleDefault = async (id: string, isDefault: boolean) => {
    try {
      await updateClaudeAccount(id, { isDefault });
      await reload();
    } catch (err) {
      setError((err as Error).message || (isDefault ? 'Failed to set default' : 'Failed to clear default'));
    }
  };

  const handleDelete = async (account: ClaudeAccount) => {
    // Deliberately blunt: resolveAccountToken throws for a missing account, so a
    // pinned task fails its next turn rather than quietly running on the
    // workspace's own subscription. Rotating the token is the non-destructive way
    // to replace a credential.
    const ok = confirm(
      `Remove "${account.label}"?\n\n` +
      'Any task still pinned to it will FAIL on its next turn — it will not fall back to the ' +
      "workspace's own Claude login. Re-point those tasks first, or use Edit to replace the " +
      'token instead of removing the account.',
    );
    if (!ok) return;
    try {
      await deleteClaudeAccount(account.id);
      await reload();
    } catch (err) {
      setError((err as Error).message || 'Failed to remove account');
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-start sm:items-center justify-center p-4 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-gray-900 rounded-xl shadow-xl w-full max-w-2xl my-8"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-800">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Claude subscriptions</h2>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              Choose which subscription a task runs on, instead of using the workspace's own login.
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 p-1"
            aria-label="Close"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-6 py-5 space-y-6">
          {error && (
            <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/40 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <section>
            <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-2">Saved accounts</h3>
            {loading ? (
              <p className="text-sm text-gray-500 dark:text-gray-400">Loading…</p>
            ) : accounts.length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                No accounts yet. Tasks use the Claude login inside each workspace.
              </p>
            ) : (
              <ul className="space-y-2">
                {accounts.map(account => {
                  const check = checks[account.id];
                  const editing = editingId === account.id;
                  return (
                    <li
                      key={account.id}
                      className="border border-gray-200 dark:border-gray-800 rounded-lg px-3 py-2.5"
                    >
                      {editing ? (
                        <div className="space-y-2">
                          <input
                            type="text"
                            value={editLabel}
                            onChange={e => setEditLabel(e.target.value)}
                            placeholder="Label"
                            maxLength={60}
                            autoFocus
                            className="w-full text-sm px-2 py-1.5 rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                          />
                          <input
                            type="password"
                            value={editToken}
                            onChange={e => setEditToken(e.target.value)}
                            placeholder={`Replace token (leave blank to keep …${account.tokenHint})`}
                            autoComplete="off"
                            spellCheck={false}
                            className="w-full text-sm px-2 py-1.5 rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 font-mono"
                          />
                          <p className="text-xs text-gray-500 dark:text-gray-400">
                            Replacing the token keeps this account's identity, so tasks already pinned to it keep working.
                          </p>
                          <div className="flex items-center gap-1.5">
                            <button
                              onClick={() => handleSaveEdit(account)}
                              disabled={savingEdit}
                              className="text-xs px-2.5 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                            >
                              {savingEdit ? 'Saving…' : 'Save'}
                            </button>
                            <button
                              onClick={() => setEditingId(null)}
                              className="text-xs px-2.5 py-1 rounded border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                                {account.label}
                              </span>
                              {account.isDefault && (
                                <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300">
                                  Default
                                </span>
                              )}
                            </div>
                            <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                              ends in …{account.tokenHint}
                              {account.lastUsedAt && ` · last used ${new Date(account.lastUsedAt).toLocaleString()}`}
                            </div>
                            <UsageSummary limits={rateLimits[account.id]} />
                            {check && check !== 'pending' && (
                              <div className={`text-xs mt-1 ${
                                check.status === 'valid' ? 'text-green-600 dark:text-green-400'
                                  : check.status === 'rejected' ? 'text-red-600 dark:text-red-400'
                                  : 'text-amber-700 dark:text-amber-400'
                              }`}>
                                {check.detail}
                              </div>
                            )}
                          </div>
                          <div className="flex items-center gap-1.5">
                            <button
                              onClick={() => handleVerify(account.id)}
                              disabled={check === 'pending'}
                              className="text-xs px-2 py-1 rounded border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
                            >
                              {check === 'pending' ? 'Checking…' : 'Test'}
                            </button>
                            <button
                              onClick={() => startEdit(account)}
                              className="text-xs px-2 py-1 rounded border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
                            >
                              Edit
                            </button>
                            <button
                              onClick={() => handleToggleDefault(account.id, !account.isDefault)}
                              title={account.isDefault
                                ? 'Stop using this subscription for tasks that do not name one (MCP, task-request approval)'
                                : 'Use this subscription for tasks that do not name one'}
                              className="text-xs px-2 py-1 rounded border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
                            >
                              {account.isDefault ? 'Clear default' : 'Make default'}
                            </button>
                            <button
                              onClick={() => handleDelete(account)}
                              className="text-xs px-2 py-1 rounded border border-red-300 dark:border-red-900 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40"
                            >
                              Remove
                            </button>
                          </div>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section>
            <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-1">Add an account</h3>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
              Log into the subscription you want, run{' '}
              <code className="px-1 py-0.5 rounded bg-gray-100 dark:bg-gray-800 font-mono">claude setup-token</code>, and
              paste the <code className="px-1 py-0.5 rounded bg-gray-100 dark:bg-gray-800 font-mono">sk-ant-oat…</code> value
              it prints. The token is encrypted before it is stored and is never sent back to the browser.
            </p>
            <form onSubmit={handleAdd} className="space-y-3">
              <input
                type="text"
                value={label}
                onChange={e => setLabel(e.target.value)}
                placeholder="Label (e.g. Personal Max, Work Max)"
                maxLength={60}
                className="w-full text-sm px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400"
              />
              <input
                type="password"
                value={token}
                onChange={e => setToken(e.target.value)}
                placeholder="sk-ant-oat01-…"
                autoComplete="off"
                spellCheck={false}
                className="w-full text-sm px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 font-mono"
              />
              <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                <input
                  type="checkbox"
                  checked={makeDefault}
                  onChange={e => setMakeDefault(e.target.checked)}
                  className="rounded border-gray-300 dark:border-gray-700"
                />
                Use for new tasks by default
              </label>
              <button
                type="submit"
                disabled={saving || !label.trim() || !token.trim()}
                className="text-sm px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {saving ? 'Saving…' : 'Add account'}
              </button>
            </form>
          </section>
        </div>
      </div>
    </div>
  );
}
