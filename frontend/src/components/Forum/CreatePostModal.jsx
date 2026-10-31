import { useState } from 'react';
import { createPost } from '../../api/forum';

export default function CreatePostModal({ token, onClose, onCreated }) {
  const [form, setForm] = useState({ title: '', content: '' });
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
      await createPost(token, form);
      onCreated();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>New post</h2>
        <form onSubmit={handleSubmit}>
          <input
            name="title"
            placeholder="Title"
            aria-label="Title"
            value={form.title}
            onChange={handleChange}
            maxLength={100}
            required
          />
          <textarea
            name="content"
            placeholder="What's on your mind?"
            aria-label="Post content"
            value={form.content}
            onChange={handleChange}
            maxLength={1000}
            rows={6}
            required
          />
          {error && <div className="modal-error">{error}</div>}
          <button type="submit" disabled={loading}>{loading ? 'Posting...' : 'Post'}</button>
        </form>
        <button className="modal-close" onClick={onClose}>×</button>
      </div>
    </div>
  );
}