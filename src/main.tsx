import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import { RadiosProvider } from './hooks/useRadios';
import { AuthProvider } from './hooks/useAuth';
import { WorkspacesProvider } from './hooks/useWorkspaces';
import { AuthGate } from './components/AuthGate';
import './index.css';

// v2.0 Beta 5: AuthProvider wraps everything so any component can call
// useAuth(). AuthGate sits inside it and renders the login/bootstrap
// screen in place of <App /> when the user isn't signed in — the rest of
// the providers don't get mounted until auth is settled so they don't
// hammer the API with 401s during the login screen.
//
// WorkspacesProvider sits inside AuthGate (after auth) but outside
// RadiosProvider, because RadiosProvider's data fetches depend on the
// current workspace being known.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <AuthGate>
        <WorkspacesProvider>
          <RadiosProvider>
            <App />
          </RadiosProvider>
        </WorkspacesProvider>
      </AuthGate>
    </AuthProvider>
  </StrictMode>,
);
