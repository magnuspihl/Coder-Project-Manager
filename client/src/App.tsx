import { useState, useEffect } from 'react';
import { getMe, type User } from './api/client';
import LoginPage from './pages/LoginPage';
import WorkspacesPage from './pages/WorkspacesPage';
import Layout from './components/Layout';
import { ImageLightboxProvider } from './components/ImageLightbox';

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getMe()
      .then(({ user }) => setUser(user))
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
    return <LoginPage onLogin={setUser} />;
  }

  return (
    <ImageLightboxProvider>
      <Layout>
        <WorkspacesPage />
      </Layout>
    </ImageLightboxProvider>
  );
}
