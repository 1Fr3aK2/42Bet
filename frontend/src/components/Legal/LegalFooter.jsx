import { useEffect, useState } from 'react';
import PrivacyPolicy from './PrivacyPolicy';
import TermsOfService from './TermsOfService';

// Footer with the links to the legal pages. The open page follows the URL
// hash (#/privacy, #/terms): each page has its own link, the browser's back
// button closes it, and no server route is needed. It is rendered next to
// <App /> in main.jsx, so the rest of the app does not change.
const PAGES = {
  '#/privacy': PrivacyPolicy,
  '#/terms': TermsOfService,
};

export default function LegalFooter() {
  const [hash, setHash] = useState(window.location.hash);
  const Page = PAGES[hash];

  useEffect(() => {
    const onHashChange = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  function close() {
    // Remove the hash without reloading the page or adding a history entry.
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    setHash('');
  }

  useEffect(() => {
    if (!Page) return undefined;
    // Move the focus to the page title, so screen readers start reading there.
    document.getElementById('legal-title')?.focus();
    const onKeyDown = (e) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [Page]);

  return (
    <>
      <footer className="legal-footer">
        <span>© 2026 Transcendence · a 42 Lisboa student project</span>
        <nav aria-label="Legal">
          <a href="#/privacy">Privacy Policy</a>
          <a href="#/terms">Terms of Service</a>
        </nav>
      </footer>

      {Page && (
        <div className="settings-page forum-page" role="dialog" aria-modal="true" aria-labelledby="legal-title">
          <button className="settings-close" onClick={close} aria-label="Close">×</button>
          <div className="forum-container legal-content">
            <Page />
          </div>
        </div>
      )}
    </>
  );
}
