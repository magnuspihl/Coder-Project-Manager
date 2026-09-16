import { useState, useEffect } from 'react';
import { getMe, type User } from './api/client';
import LoginPage from './pages/LoginPage';
import WorkspacesPage from './pages/WorkspacesPage';
import Layout from './components/Layout';
import { ImageLightboxProvider } from './components/ImageLightbox';

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getMe()
      .then(({ user, is_admin }) => { setUser(user); setIsAdmin(is_admin); })
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

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
    // Token login returns only the user, so re-read /auth/me to pick up
    // is_admin rather than leaving admin controls hidden until a reload.
    return (
      <LoginPage
        onLogin={(loggedIn) => {
          setUser(loggedIn);
          getMe().then(({ is_admin }) => setIsAdmin(is_admin)).catch(() => setIsAdmin(false));
        }}
      />
    );
  }

  return (
    <ImageLightboxProvider>
      <Layout isAdmin={isAdmin}>
        <WorkspacesPage />
      </Layout>
    </ImageLightboxProvider>
  );
}
