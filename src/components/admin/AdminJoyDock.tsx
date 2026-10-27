import { useEffect, useState } from 'react';
import AdminJoyDockView from './AdminJoyDockView';
import { useAdminJoySession } from './useAdminJoyConsole';

const GREETING_STORAGE_KEY = 'ishmaverse-admin-joy-greeted';

/**
 * Mounts the admin assistant for the whole dashboard.
 *
 * It reuses the same engine as the dedicated Admin Joy page
 * (`useAdminJoyConsole` → server-verified session → permission-checked
 * `admin-ops` → confirmations and audit), and the same chrome as Home Joy
 * (`components/joy/JoyUI`). Nothing is rendered until the server-verified admin
 * session is known, so a visitor never sees a privileged surface.
 */
const AdminJoyDock: React.FC<{ onOpenFull: () => void }> = ({ onOpenFull }) => {
  const {
    adminLoading,
    isAdmin,
    messages,
    input,
    setInput,
    run,
    pending,
    confirmPending,
    cancelPending,
    notice,
    dismissNotice,
    scrollRef,
  } = useAdminJoySession();
  const [open, setOpen] = useState(false);
  const [greeting, setGreeting] = useState(false);

  /* The welcome tooltip appears once per session, like Home Joy's. */
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.sessionStorage.getItem(GREETING_STORAGE_KEY)) return;
    const timer = window.setTimeout(() => setGreeting(true), 1200);
    return () => window.clearTimeout(timer);
  }, []);

  /* …and dismisses itself so it never keeps covering the dashboard. */
  useEffect(() => {
    if (!greeting || open) return;
    const timer = window.setTimeout(() => setGreeting(false), 9000);
    return () => window.clearTimeout(timer);
  }, [greeting, open]);

  const openChat = () => {
    setGreeting(false);
    setOpen(true);
    try {
      window.sessionStorage.setItem(GREETING_STORAGE_KEY, '1');
    } catch {
      /* sessionStorage unavailable — the tooltip simply shows again next visit. */
    }
  };

  if (adminLoading || !isAdmin) return null;

  return (
    <AdminJoyDockView
      open={open}
      onOpen={openChat}
      onClose={() => setOpen(false)}
      onOpenFull={() => {
        setOpen(false);
        onOpenFull();
      }}
      messages={messages}
      input={input}
      onInput={setInput}
      onSend={() => void run(input)}
      onRun={(text) => void run(text)}
      pending={pending}
      onConfirm={confirmPending}
      onCancel={cancelPending}
      notice={notice}
      onDismissNotice={dismissNotice}
      greeting={greeting}
      onDismissGreeting={() => setGreeting(false)}
      bodyRef={scrollRef}
    />
  );
};

export default AdminJoyDock;
