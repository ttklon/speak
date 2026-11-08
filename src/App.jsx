import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Sidebar from './components/layout/Sidebar.jsx';
import TitleBar from './components/layout/TitleBar.jsx';
import HomePage from './pages/HomePage.jsx';
import DictionaryPage from './pages/DictionaryPage.jsx';
import HotkeysPage from './pages/HotkeysPage.jsx';
import MeetingsPage from './pages/MeetingsPage.jsx';
import TranslatePage from './pages/TranslatePage.jsx';
import ClipboardPage from './pages/ClipboardPage.jsx';
import MobileModal from './components/modals/MobileModal.jsx';
import SettingsModal from './components/settings/SettingsModal.jsx';
import ProfileModal from './components/modals/ProfileModal.jsx';
import DictationHUD from './components/ui/DictationHUD.jsx';
import { useRoute, navigate } from './lib/router.js';
import { useAppData } from './state/AppDataProvider.jsx';
import { useToast } from './state/ToastProvider.jsx';

const PAGES = {
  home: HomePage,
  dictionary: DictionaryPage,
  hotkeys: HotkeysPage,
  meetings: MeetingsPage,
  translate: TranslatePage,
  clipboard: ClipboardPage,
};

export default function App() {
  const route = useRoute();
  const { updateSettings } = useAppData();
  const { push } = useToast();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState('account');
  const [profileOpen, setProfileOpen] = useState(false);

  const prevPage = useRef(route.page);
  const openedFromHash = useRef(false);

  // Поддержка прямых ссылок вида #/settings?section=features
  useEffect(() => {
    if (route.page === 'settings') {
      openedFromHash.current = true;
      setSettingsSection(route.params.section || 'account');
      setSettingsOpen(true);
      navigate(route.params.from || 'home');
    }
  }, [route]);

  // Переход на другую страницу закрывает модалки (кроме случая открытия из hash)
  useEffect(() => {
    if (prevPage.current === route.page) return;
    prevPage.current = route.page;
    if (openedFromHash.current) {
      openedFromHash.current = false;
      return;
    }
    setMobileOpen(false);
    setProfileOpen(false);
    setSettingsOpen(false);
  }, [route.page]);

  // Ctrl+, — настройки, Ctrl+K — поиск по буферу
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault();
        setSettingsOpen(true);
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        navigate('clipboard');
        setTimeout(() => {
          const input = document.querySelector('.clip-toolbar .search-input input');
          input?.focus();
        }, 90);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Команды из трея / меню Electron
  useEffect(() => {
    const bridge = window.zspeakly?.native;
    if (!bridge?.onCommand) return undefined;
    return bridge.onCommand((command) => {
      if (command === 'settings') setSettingsOpen(true);
      if (command === 'clipboard') navigate('clipboard');
      if (command === 'home') navigate('home');
      if (command === 'mobile') setMobileOpen(true);
      if (command === 'about') {
        setSettingsSection('about');
        setSettingsOpen(true);
      }
    });
  }, []);

  // Новые элементы буфера из main-процесса
  useEffect(() => {
    const bridge = window.zspeakly?.native;
    if (!bridge?.onClipboard) return undefined;
    return bridge.onClipboard((item) => {
      if (item?.text) {
        window.dispatchEvent(new CustomEvent('zs:clipboard', { detail: item }));
      }
    });
  }, []);

  const openMobile = useCallback(() => setMobileOpen(true), []);
  const openProfile = useCallback(() => setProfileOpen(true), []);
  const openSettings = useCallback((section = 'account') => {
    setSettingsSection(section);
    setSettingsOpen(true);
  }, []);
  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    updateSettings({ lastSettingsVisit: Date.now() });
  }, [updateSettings]);

  const content = useMemo(() => {
    if (page(route) === 'home') return <HomePage onOpenSettings={openSettings} onOpenMobile={openMobile} />;
    const Page = PAGES[page(route)] || HomePage;
    return <Page onOpenSettings={openSettings} />;
  }, [route, openSettings, openMobile]);

  return (
    <div className="app-shell">
      <div className="app-window">
        <TitleBar />
        <div className="app-body">
          <Sidebar
            page={page(route)}
            onOpenSettings={() => openSettings('account')}
            onOpenMobile={openMobile}
            onOpenProfile={openProfile}
          />
          <main className="content">{content}</main>
        </div>
      </div>

      <DictationHUD />

      <MobileModal open={mobileOpen} onClose={() => setMobileOpen(false)} />
      <ProfileModal
        open={profileOpen}
        onClose={() => setProfileOpen(false)}
        onOpenSettings={() => {
          setProfileOpen(false);
          openSettings('account');
        }}
      />
      <SettingsModal
        open={settingsOpen}
        section={settingsSection}
        onSectionChange={setSettingsSection}
        onClose={closeSettings}
      />
    </div>
  );
}

function page(route) {
  return route.page === 'settings' ? 'home' : route.page;
}
