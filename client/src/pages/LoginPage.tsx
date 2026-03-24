import { useState, useEffect, type FormEvent } from 'react';
import { tokenLogin, getAuthConfig, type User } from '../api/client';
import { useTheme } from '../hooks/useTheme';

export default function LoginPage({ onLogin }: { onLogin: (user: User) => void }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [oauthEnabled, setOauthEnabled] = useState(false);
  const [showTokenForm, setShowTokenForm] = useState(false);

  useTheme();

  useEffect(() => {
    getAuthConfig()
      .then(({ oauth_enabled }) => setOauthEnabled(oauth_enabled))
      .catch(() => {});
  }, []);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { user } = await tokenLogin(token);
      onLogin(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  const handleOAuthLogin = () => {
    window.location.href = '/auth/login';
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950">
      <div className="bg-white dark:bg-gray-900 rounded-lg shadow-sm border border-gray-200 dark:border-gray-800 p-8 w-full max-w-md">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-2">Coder Project Manager</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
          Connect to your Coder instance to manage tasks across workspaces.
        </p>

        {oauthEnabled && (
          <div className="space-y-4">
            <button
              onClick={handleOAuthLogin}
              className="w-full bg-blue-600 text-white py-2 px-4 rounded-md text-sm font-medium hover:bg-blue-700 flex items-center justify-center gap-2"
            >
              Sign in with Coder
            </button>

            {!showTokenForm && (
              <button
                onClick={() => setShowTokenForm(true)}
                className="w-full text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
              >
                Use API token instead
              </button>
            )}
          </div>
        )}

        {(showTokenForm || !oauthEnabled) && (
          <form onSubmit={handleSubmit} className={`space-y-4 ${oauthEnabled ? 'mt-4 pt-4 border-t border-gray-200 dark:border-gray-800' : ''}`}>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Coder API Token
              </label>
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Paste your Coder API token"
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                required
              />
              <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                Generate a token at your Coder dashboard under Settings &rarr; Tokens
              </p>
            </div>

            {error && (
              <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md px-3 py-2">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading || !token.trim()}
              className="w-full bg-blue-600 text-white py-2 px-4 rounded-md text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? 'Connecting...' : 'Connect'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
