import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/inter/800.css';
import '@fontsource/jetbrains-mono/400.css';
import './styles/base.css';
import './styles/layout.css';
import './styles/components.css';
import './styles/pages.css';
import './styles/extra.css';
import App from './App.jsx';
import { AppDataProvider } from './state/AppDataProvider.jsx';
import { DictationProvider } from './state/DictationProvider.jsx';
import { ToastProvider } from './state/ToastProvider.jsx';
import { isElectron } from './lib/storage.js';
import { installErrorHooks } from './lib/diagnostics.js';

if (!isElectron()) document.body.classList.add('web');

// Перехватываем ошибки интерфейса до первого рендера: иначе падение в
// компоненте видно только в DevTools, которого у пользователя нет.
installErrorHooks();

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ToastProvider>
      <AppDataProvider>
        <DictationProvider>
          <App />
        </DictationProvider>
      </AppDataProvider>
    </ToastProvider>
  </React.StrictMode>,
);
