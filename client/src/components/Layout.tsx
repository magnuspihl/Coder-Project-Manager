import { useState, type ReactNode } from 'react';
import { restartCpm } from '../api/client';
import { useTheme } from '../hooks/useTheme';

export default function Layout({
  children,
}: {
  user?: unknown;
  onLogout?: () => void;
  selfChatUrl?: string | null;
  children: ReactNode;
}) {
  const { theme, setTheme } = useTheme();
  const [restarting, setRestarting] = useState(false);
  const [restartError, setRestartError] = useState('');

  const handleRestart = () => {
    if (!confirm('Restart CPM? This will rebuild and restart the server. Active SSH processes will be reconnected automatically.')) return;
    setRestarting(true);
    setRestartError('');
    restartCpm()
      .then(() => {
        // Server will go down — poll until it comes back
        const poll = setInterval(() => {
          fetch('/auth/config', { credentials: 'include' })
            .then(r => { if (r.ok) { clearInterval(poll); window.location.reload(); } })
            .catch(() => {}); // still down
        }, 2000);
      })
      .catch(err => {
        setRestarting(false);
        setRestartError(err.message || 'Restart failed');
      });
  };

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <header className="flex-shrink-0 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 px-6 py-3 flex items-center justify-between">
        <span className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          Coder Project Manager
        </span>
        <div className="flex items-center gap-4">
          {restartError && (
            <span className="text-xs text-red-500">{restartError}</span>
          )}
          <button
            onClick={handleRestart}
            disabled={restarting}
            className={`text-xs px-3 py-1.5 rounded-full transition-colors flex items-center gap-1.5 ${
              restarting
                ? 'bg-gray-400 text-white cursor-not-allowed'
                : 'bg-gray-600 text-white hover:bg-gray-700'
            }`}
            title="Rebuild and restart CPM server"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            {restarting ? 'Restarting...' : 'Restart CPM'}
          </button>
          <div className="flex items-center bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-0.5">
            {([
              { value: 'light' as const, title: 'Light', icon: (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v1m0 16v1m8.66-13.66l-.71.71M4.05 19.07l-.71.71M21 12h-1M4 12H3m16.66 7.66l-.71-.71M4.05 4.93l-.71-.71M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
                </svg>
              )},
              { value: 'system' as const, title: 'System', icon: (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
              )},
              { value: 'dark' as const, title: 'Dark', icon: (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
                </svg>
              )},
            ]).map(({ value, title, icon }) => (
              <button
                key={value}
                onClick={() => setTheme(value)}
                title={title}
                className={`p-1.5 rounded-md transition-colors ${
                  theme === value
                    ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm'
                    : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
                }`}
              >
                {icon}
              </button>
            ))}
          </div>
        </div>
      </header>
      <main className="flex-1 px-6 py-6 overflow-hidden flex flex-col">{children}</main>
    </div>
  );
}
