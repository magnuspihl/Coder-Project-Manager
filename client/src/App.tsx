import { useState, useEffect } from 'react';
import { getMe, getAuthConfig, getWorkspaces, type User } from './api/client';
import LoginPage from './pages/LoginPage';
import WorkspacesPage from './pages/WorkspacesPage';
import Layout from './components/Layout';

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [selfWorkspaceId, setSelfWorkspaceId] = useState<string | null>(null);
  const [selfChatUrl, setSelfChatUrl] = useState<string | null>(null);

  useEffect(() => {
    getMe()
      .then(({ user }) => setUser(user))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));

    getAuthConfig().then((config) => {
      setSelfWorkspaceId(config.self_workspace_id);
    }).catch(() => {});
  }, []);

  // Discover CCW chat URL for self workspace
  useEffect(() => {
    if (!selfWorkspaceId) return;
    const discover = () => {
      getWorkspaces().then(({ workspaces }) => {
        const self = workspaces.find(w => w.id === selfWorkspaceId);
        if (self?.apps) {
          const ccw = self.apps.find(a => a.slug === 'ccw');
          if (ccw) {
            // Append chat/embed/ to the app URL
            const url = ccw.url.endsWith('/') ? ccw.url + 'chat/embed/' : ccw.url + '/chat/embed/';
            setSelfChatUrl(url);
          }
        }
      }).catch(() => {});
    };
    discover();
  }, [selfWorkspaceId]);

  // Listen for session expiry from API client and redirect to login
  useEffect(() => {
    const handleExpired = () => setUser(null);
    window.addEventListener('auth:expired', handleExpired);
    return () => window.removeEventListener('auth:expired', handleExpired);
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-gray-500 dark:text-gray-400">Loading...</div>
      </div>
    );
  }

  if (!user) {
    return <LoginPage onLogin={setUser} />;
  }

  return (
    <Layout user={user} onLogout={() => setUser(null)} selfChatUrl={selfChatUrl}>
      <WorkspacesPage selfWorkspaceId={selfWorkspaceId} />
    </Layout>
  );
}
