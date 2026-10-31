import { useState } from 'react';
import { updateUser, changePassword, AVATAR_TYPES } from '../api/users';

export default function SettingsPage({ user, onClose, onUpdate }) {
  const [tab, setTab] = useState('profile');

  return (
    <div className="settings-page">
      <button className="settings-close" onClick={onClose}>×</button>

      <aside className="settings-sidebar">
        <div className="settings-sidebar-header">Account</div>
        <button
          className={`settings-tab ${tab === 'profile' ? 'active' : ''}`}
          onClick={() => setTab('profile')}
        >
          Profile
        </button>
        <button
          className={`settings-tab ${tab === 'security' ? 'active' : ''}`}
          onClick={() => setTab('security')}
        >
          Security
        </button>
      </aside>

      <section className="settings-content">
        {tab === 'profile' && <ProfileTab user={user} onUpdate={onUpdate} />}
        {tab === 'security' && <SecurityTab />}
      </section>
    </div>
  );
}

function ProfileTab({ user, onUpdate }) {
  const [username, setUsername] = useState(user?.username || '');
  const [avatarFile, setAvatarFile] = useState(null);
  const [avatarPreview, setAvatarPreview] = useState(user?.avatar || null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  function handleAvatarChange(e) {
    const file = e.target.files[0];
    if (!file) return;
    // Pictures only: the server refuses anything else. Big photos are fine,
    // they are shrunk before being sent (api/users.js).
    if (!AVATAR_TYPES.includes(file.type) || file.size > 10 * 1024 * 1024) {
      setError('The picture must be a PNG, JPEG, GIF or WebP image of 10 MB or less');
      return;
    }
    setError('');
    setAvatarFile(file);
    setAvatarPreview(URL.createObjectURL(file));
  }

  async function handleSave(e) {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      const updated = await updateUser({ username, avatarFile });
      onUpdate(updated);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  const initial = username.charAt(0).toUpperCase() || '?';

  return (
    <form className="settings-form" onSubmit={handleSave}>
      <h2>Profile</h2>

      <div className="settings-avatar-row">
        <div className="settings-avatar-preview">
          {avatarPreview ? <img src={avatarPreview} alt="Avatar preview" /> : initial}
        </div>
        <label className="settings-avatar-upload">
          Change picture
          <input type="file" accept={AVATAR_TYPES.join(',')} onChange={handleAvatarChange} hidden />
        </label>
      </div>

      <label className="settings-field">
        Username
        <input
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
          minLength={3}
          maxLength={20}
          pattern="[A-Za-z0-9_.\-]{3,20}"
          title="3 to 20 letters, digits, _ . or -"
        />
      </label>

      {error && <div className="modal-error">{error}</div>}

      <button type="submit" className="settings-save-btn" disabled={saving}>
        {saving ? 'Saving...' : 'Save changes'}
      </button>
    </form>
  );
}

function SecurityTab() {
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  function handleChange(e) {
    const { name, value } = e.target;
    setForm((f) => ({ ...f, [name]: value }));
  }

  async function handleSave(e) {
    e.preventDefault();
    setError('');
    setSuccess(false);

    if (form.newPassword !== form.confirmPassword) {
      setError('New passwords do not match');
      return;
    }

    setSaving(true);
    try {
      await changePassword(form);
      setSuccess(true);
      setForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="settings-form" onSubmit={handleSave}>
      <h2>Security</h2>

      <label className="settings-field">
        Current password
        <input type="password" name="currentPassword" value={form.currentPassword} onChange={handleChange} required />
      </label>
      <label className="settings-field">
        New password
        <input type="password" name="newPassword" value={form.newPassword} onChange={handleChange} required minLength={8} />
      </label>
      <label className="settings-field">
        Confirm new password
        <input type="password" name="confirmPassword" value={form.confirmPassword} onChange={handleChange} required minLength={8} />
      </label>

      {error && <div className="modal-error">{error}</div>}
      {success && <div className="settings-success">Password updated</div>}

      <button type="submit" className="settings-save-btn" disabled={saving}>
        {saving ? 'Saving...' : 'Save changes'}
      </button>
    </form>
  );
}