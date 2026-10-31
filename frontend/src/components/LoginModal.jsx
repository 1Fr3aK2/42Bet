import { useState } from 'react';
import { loginUser } from '../api/auth';

export default function LoginModal({ onClose, onSuccess }) {
  const [form, setForm] = useState({ username: '', password: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  function handleChange(e) {
    const { name, value } = e.target;
    setForm((f) => ({ ...f, [name]: value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { access_token } = await loginUser(form);
      onSuccess(access_token);
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Login</h2>
        <form onSubmit={handleSubmit}>

          {/* The backend accepts the username or the email in this field */}
          <input name="username" type="text" placeholder="Username or email" aria-label="Username or email" autoComplete="username" value={form.username} onChange={handleChange} required />
          <input name="password" type="password" placeholder="Password" aria-label="Password" autoComplete="current-password" value={form.password} onChange={handleChange} required />
          {error && <div className="modal-error">{error}</div>}
          <button type="submit" disabled={loading}>{loading ? 'Logging in...' : 'Login'}</button>
        </form>
        <button className="modal-close" aria-label="Close" onClick={onClose}>×</button>
      </div>
    </div>
  );
}