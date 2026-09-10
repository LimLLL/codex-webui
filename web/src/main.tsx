import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { queryClient } from './lib/query-client';
import { configureApiClient } from './api-client';
import { router } from './routes/router';
import { useThemeStore } from './stores/theme-store';
import { installMobileViewportFixes } from './lib/mobile-viewport';
import './i18n';
import './index.css';

configureApiClient();
installMobileViewportFixes();

// Apply persisted theme before first render to avoid flash
document.documentElement.classList.toggle('dark', useThemeStore.getState().dark);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
