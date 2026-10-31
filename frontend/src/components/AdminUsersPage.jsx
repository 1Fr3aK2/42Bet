import { useState, useEffect, useCallback } from 'react';
import { getUsers, updateUserRole } from '../api/users';

const ROLE_ORDER = { ADMIN: 0, MODERATOR: 1, USER: 2 };

// Admin only: list every user and promote/demote moderators.
export default function AdminUsersPage({ token, currentUser, onClose }) {
  const [users, setUsers] = useState([]);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('ALL');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setUsers(await getUsers(token));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleRoleChange(user, role) {
    setBusyId(user.id);
    setError('');
    try {
      const updated = await updateUserRole(token, user.id, role);
      setUsers((us) => us.map((u) => (u.id === user.id ? { ...u, role: updated.role } : u)));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  const query = search.trim().toLowerCase();
  const visible = users
    .filter((u) => roleFilter === 'ALL' || u.role === roleFilter)
    .filter(
      (u) =>
        !query ||
        u.username.toLowerCase().includes(query) ||
        u.email.toLowerCase().includes(query)
    )
    .sort(
      (a, b) =>
        (ROLE_ORDER[a.role] ?? 3) - (ROLE_ORDER[b.role] ?? 3) ||
        a.username.localeCompare(b.username)
    );

  return (
    <div className="settings-page forum-page">
      <button className="settings-close" onClick={onClose}>×</button>

      <div className="forum-container">
        <div className="forum-header">
          <h1>Manage users</h1>
        </div>

        <div className="users-toolbar">
          <input
            className="forum-search"
            type="text"
            placeholder="Search by username or email..."
            aria-label="Search users by username or email"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select
            className="forum-select"
            value={roleFilter}
            aria-label="Filter by role"
            onChange={(e) => setRoleFilter(e.target.value)}
          >
            <option value="ALL">All roles</option>
            <option value="ADMIN">Admins</option>
            <option value="MODERATOR">Moderators</option>
            <option value="USER">Users</option>
          </select>
        </div>

        {error && <div className="modal-error">{error}</div>}

        {loading ? (
          <div className="forum-empty">Loading...</div>
        ) : visible.length === 0 ? (
          <div className="forum-empty">No users match these filters.</div>
        ) : (
          <>
            <div className="users-count">
              {visible.length} {visible.length === 1 ? 'user' : 'users'}
            </div>
            <div className="forum-list">
              {visible.map((u) => (
                <div className="user-row" key={u.id}>
                  <div className="user-avatar">
                    {u.avatar ? <img src={u.avatar} alt="" /> : u.username.charAt(0).toUpperCase()}
                  </div>

                  <div className="user-info">
                    <span className="user-name">
                      {u.username}
                      {u.id === currentUser?.id && ' (you)'}
                    </span>
                    <span className="user-email">{u.email}</span>
                  </div>

                  <span className={`role-badge role-badge--${u.role.toLowerCase()}`}>{u.role}</span>

                  {u.role === 'USER' && (
                    <button
                      className="mod-btn"
                      disabled={busyId === u.id}
                      onClick={() => handleRoleChange(u, 'MODERATOR')}
                    >
                      Make moderator
                    </button>
                  )}
                  {u.role === 'MODERATOR' && (
                    <button
                      className="mod-btn"
                      disabled={busyId === u.id}
                      onClick={() => handleRoleChange(u, 'USER')}
                    >
                      Remove moderator
                    </button>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
