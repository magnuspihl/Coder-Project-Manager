import { useEffect } from 'react';
import { getAuthConfig, type User } from '../api/client';
import { useTheme } from '../hooks/useTheme';

export default function LoginPage({ onLogin: _onLogin }: { onLogin: (user: User) => void }) {
  useTheme();

  useEffect(() => {
    getAuthConfig()
      .then(({ oauth_enabled }) => {
        if (oauth_enabled) {
          window.location.href = '/auth/login';
        }
      })
      .catch(() => {});
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950">
      <div className="bg-white dark:bg-gray-900 rounded-lg shadow-sm border border-gray-200 dark:border-gray-800 p-8 w-full max-w-md text-center">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-2">Coder Project Manager</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Redirecting to Coder login...
        </p>
      </div>
    </div>
  );
}
