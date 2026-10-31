import { useState, useRef, useEffect } from 'react';

export default function ProfileDropdown({ user, onLogout, onSettingsClick, onModerationClick, onAdminClick }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    function handleClickOutside(e) {
      if (ref.current && !ref.current.contains(e.target)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const initial = user.username.charAt(0).toUpperCase();
  const isAdmin = user.role === 'ADMIN';
  const isStaff = isAdmin || user.role === 'MODERATOR';

  return (
    <div className="profile-dropdown" ref={ref}>
      <button className="profile-avatar-btn" onClick={() => setOpen((o) => !o)}>
        {user.avatar ? <img src={user.avatar} alt="Avatar" /> : initial}
      </button>

      {open && (
        <div className="profile-menu">
          <div className="profile-menu-username">
            {user.username}
            {isStaff && <span className="profile-menu-role">{user.role}</span>}
          </div>
          <button
            className="profile-menu-item"
            onClick={() => {
              setOpen(false);
              onSettingsClick();
            }}
          >
            Settings
          </button>
          {isStaff && (
            <button
              className="profile-menu-item"
              onClick={() => {
                setOpen(false);
                onModerationClick();
              }}
            >
              Moderation
            </button>
          )}
          {isAdmin && (
            <button
              className="profile-menu-item"
              onClick={() => {
                setOpen(false);
                onAdminClick();
              }}
            >
              Manage users
            </button>
          )}
          <button
            className="profile-menu-item profile-menu-item--danger"
            onClick={() => {
              setOpen(false);
              onLogout();
            }}
          >
            Logout
          </button>
        </div>
      )}
    </div>
  );
}
