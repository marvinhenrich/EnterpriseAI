import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './lib/auth';
import { FullSpinner } from './components/Spinner';
import { Login } from './pages/Login';
import { Chat } from './pages/Chat';
import { Admin } from './pages/Admin';
import { Vault } from './pages/Vault';
import { Projects } from './pages/Projects';
import { ImageStudio } from './pages/ImageStudio';
import { Etiketten } from './pages/Etiketten';
import type { ReactNode } from 'react';

function Protected({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <FullSpinner />;
  return user ? <>{children}</> : <Navigate to="/login" replace />;
}

// Route hinter einer Berechtigung: ohne Login → /login, ohne Recht → zurück zum Chat.
// So sitzt nicht nur der Sidebar-Button, sondern auch der direkte URL-Zugang hinter
// der Berechtigungswand (Server prüft zusätzlich, das hier ist die UI-Hürde).
function RequirePermission({ perm, children }: { perm: string; children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <FullSpinner />;
  if (!user) return <Navigate to="/login" replace />;
  if (!user.permissions?.includes(perm)) return <Navigate to="/" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            path="/"
            element={
              <Protected>
                <Chat />
              </Protected>
            }
          />
          <Route
            path="/admin"
            element={
              <RequirePermission perm="admin.access">
                <Admin />
              </RequirePermission>
            }
          />
          <Route path="/projekte" element={<Protected><Projects /></Protected>} />
          <Route path="/projekte/:id" element={<Protected><Projects /></Protected>} />
          <Route
            path="/vault"
            element={
              <RequirePermission perm="kb.query">
                <Vault />
              </RequirePermission>
            }
          />
          {/* Alte Adresse bleibt gültig (Lesezeichen der Nutzer). */}
          <Route path="/wissensdatenbank" element={<Navigate to="/vault" replace />} />
          <Route
            path="/bilder"
            element={
              <RequirePermission perm="image.generate">
                <ImageStudio />
              </RequirePermission>
            }
          />
          <Route
            path="/etiketten"
            element={
              <RequirePermission perm="labels.read">
                <Etiketten />
              </RequirePermission>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
