import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { AdminLogin } from '../components/AdminLogin';
import { useGreeting } from '../context/GreetingContext';
import { usePageMeta } from '../hooks/usePageMeta';
import { pageTitle } from '../services/seo';

/**
 * `/admin` is the entry point: it shows the login screen and, once a verified
 * admin session exists, hands off to the unified dashboard at `/admin/dashboard`.
 */
export const Admin: React.FC = () => {
  const { isAdmin, adminLoading } = useGreeting();
  const navigate = useNavigate();

  usePageMeta({ title: pageTitle('Admin sign in'), description: 'isZma administrator sign in.', path: '/admin', noindex: true });

  useEffect(() => {
    if (!adminLoading && isAdmin) {
      navigate('/admin/dashboard', { replace: true });
    }
  }, [isAdmin, adminLoading, navigate]);

  if (adminLoading || isAdmin) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-[#0b0514] to-[#1a0b2e] flex items-center justify-center">
        <div className="animate-spin w-12 h-12 border-4 border-neon-purple border-t-transparent rounded-full" />
      </div>
    );
  }

  return <AdminLogin onLoginSuccess={() => navigate('/admin/dashboard', { replace: true })} />;
};
