import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import { RadiosProvider } from './hooks/useRadios';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RadiosProvider>
      <App />
    </RadiosProvider>
  </StrictMode>,
);
