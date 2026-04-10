import { useState, useEffect, useCallback } from 'react';
import { getMe, getAuthConfig, getOrCreateDiscussion, getWorkspaces, type User } from './api/client';
import LoginPage from './pages/LoginPage';
import WorkspacesPage from './pages/WorkspacesPage';
import Layout from './components/Layout';
import DiscussionModal from './components/DiscussionModal';

function markChatSeen(workspaceId: string) {
  try {
    const seen = JSON.parse(localStorage.getItem('chatLastSeen') || '{}');
    seen[workspaceId] = new Date().toISOString();
    localStorage.setItem('chatLastSeen', JSON.stringify(seen));
  } catch { /* ignore */ }
}

function hasUnreadChat(workspaceId: string, latestMessage: string | undefined): boolean {
  if (!latestMessage) return false;
  try {
    const seen = JSON.parse(localStorage.getItem('chatLastSeen') || '{}');
    const lastSeen = seen[workspaceId];
    if (!lastSeen) return true;
    return latestMessage > lastSeen;
  } catch { return false; }
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [selfWorkspaceId, setSelfWorkspaceId] = useState<string | null>(null);
  const [selfWorkspaceName, setSelfWorkspaceName] = useState<string | null>(null);
  const [selfDiscussion, setSelfDiscussion] = useState<{ id: string } | null>(null);
  const [selfLatestMessage, setSelfLatestMessage] = useState<string | undefined>(undefined);

  useEffect(() => {
    getMe()
      .then(({ user }) => setUser(user))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));

    getAuthConfig().then((config) => {
      setSelfWorkspaceId(config.self_workspace_id);
      setSelfWorkspaceName(config.self_workspace_name);
    }).catch(() => {});
  }, []);

  // Poll for unread status on self workspace
  useEffect(() => {
    if (!selfWorkspaceId) return;
    const checkUnread = () => {
      getWorkspaces().then(({ latestDiscussionMessages }) => {
        setSelfLatestMessage(latestDiscussionMessages?.[selfWorkspaceId]);
      }).catch(() => {});
    };
    checkUnread();
    const interval = setInterval(checkUnread, 15000);
    return () => clearInterval(interval);
  }, [selfWorkspaceId]);

  // Listen for session expiry from API client and redirect to login
  useEffect(() => {
    const handleExpired = () => setUser(null);
    window.addEventListener('auth:expired', handleExpired);
    return () => window.removeEventListener('auth:expired', handleExpired);
  }, []);

  const handleOpenSelfChat = useCallback(async () => {
    if (!selfWorkspaceId) return;
    try {
      markChatSeen(selfWorkspaceId);
      const { discussion } = await getOrCreateDiscussion(selfWorkspaceId);
      setSelfDiscussion({ id: discussion.id });
    } catch {
      // ignore
    }
  }, [selfWorkspaceId]);

  const handleCloseSelfChat = useCallback(() => {
    if (selfWorkspaceId) markChatSeen(selfWorkspaceId);
    setSelfDiscussion(null);
  }, [selfWorkspaceId]);

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

  const selfUnread = selfWorkspaceId ? hasUnreadChat(selfWorkspaceId, selfLatestMessage) : false;

  return (
    <Layout
      user={user}
      onLogout={() => setUser(null)}
      onOpenSelfChat={selfWorkspaceId ? handleOpenSelfChat : undefined}
      selfChatUnread={selfUnread && !selfDiscussion}
    >
      <WorkspacesPage selfWorkspaceId={selfWorkspaceId} />
      {selfDiscussion && selfWorkspaceId && selfWorkspaceName && (
        <DiscussionModal
          discussionId={selfDiscussion.id}
          workspaceId={selfWorkspaceId}
          workspaceName={selfWorkspaceName}
          onClose={handleCloseSelfChat}
        />
      )}
    </Layout>
  );
}
