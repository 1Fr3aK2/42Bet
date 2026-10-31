import ProfileDropdown from './ProfileDropdown';

export default function Navbar({ balance, onRegisterClick, onLoginClick, onSettingsClick, onForumClick, onModerationClick, onAdminClick, currentUser, onLogout }) {
  return (
    <nav className="navbar">
      <div className="logo">
        <span className="logo-text">Transcendence</span>
        <span className="logo-tag">Beta</span>
      </div>

      <div className="nav-actions">
        <div className="nav-icons">
          <button className="nav-icon-btn" title="Search the forum" aria-label="Search the forum" onClick={onForumClick}>
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </button>
          <button className="nav-icon-btn" title="Forum" onClick={onForumClick}>
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
            </svg>
          </button>
          <button className="nav-icon-btn" title="Analytics" aria-label="Analytics" onClick={() => { window.location.hash = '#/analytics'; }}>
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <line x1="6" y1="20" x2="6" y2="14" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="18" y1="20" x2="18" y2="10" />
            </svg>
          </button>
          <button className="nav-icon-btn" title="Settings" onClick={onSettingsClick}>
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </div>

        <div className="nav-divider" />

        {/* The balance comes from the server: null for guests and while it loads */}
        {balance !== null && (
          <>
            <div className="nav-balance">
              <span className="nav-balance-label">Balance</span>
              <span className="nav-balance-value">
                {balance.toLocaleString('en-US', { minimumFractionDigits: 0 })} T$
              </span>
            </div>

            <div className="nav-divider" />
          </>
        )}

        {currentUser ? (
          <ProfileDropdown
            user={currentUser}
            onLogout={onLogout}
            onSettingsClick={onSettingsClick}
            onModerationClick={onModerationClick}
            onAdminClick={onAdminClick}
          />
        ) : (
          <>
            <button className="nav-btn nav-btn--ghost" onClick={onLoginClick}>Login</button>
            <button className="nav-btn nav-btn--solid" onClick={onRegisterClick}>Register</button>
          </>
        )}
      </div>
    </nav>
  );
}