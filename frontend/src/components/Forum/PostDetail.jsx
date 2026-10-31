import { useState, useEffect, useCallback } from 'react';
import { getPost, getComments, createComment, deletePost, deleteComment } from '../../api/forum';
import ReportModal from './ReportModal';

export default function PostDetail({ token, currentUser, postId, onBack, onClose }) {
  const [post, setPost] = useState(null);
  const [comments, setComments] = useState([]);
  const [commentText, setCommentText] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [posting, setPosting] = useState(false);
  const [reportTarget, setReportTarget] = useState(null); // { type, id }

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [postData, commentsData] = await Promise.all([
        getPost(token, postId),
        getComments(token, postId),
      ]);
      setPost(postData);
      setComments(commentsData);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [token, postId]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleAddComment(e) {
    e.preventDefault();
    if (!commentText.trim()) return;
    setPosting(true);
    try {
      const newComment = await createComment(token, postId, commentText);
      setComments((c) => [...c, newComment]);
      setCommentText('');
    } catch (err) {
      setError(err.message);
    } finally {
      setPosting(false);
    }
  }

  async function handleDeletePost() {
    if (!confirm('Delete this post?')) return;
    try {
      await deletePost(token, postId);
      onBack();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleDeleteComment(id) {
    if (!confirm('Delete this comment?')) return;
    try {
      await deleteComment(token, id);
      setComments((c) => c.filter((cm) => cm.id !== id));
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="settings-page forum-page">
      <button className="settings-close" onClick={onClose}>×</button>

      <div className="forum-container">
        <button className="forum-back" onClick={onBack}>‹ Back to forum</button>

        {loading && <div className="forum-empty">Loading...</div>}
        {error && <div className="modal-error">{error}</div>}

        {post && (
          <>
            <div className="post-detail">
              <h1>{post.title}</h1>
              <p className="post-detail-content">{post.content}</p>
              <div className="post-detail-actions">
                <button className="forum-link-btn" onClick={() => setReportTarget({ type: 'post', id: post.id })}>
                  Report
                </button>
                {post.authorId === currentUser?.id && (
                  <button className="forum-link-btn forum-link-btn--danger" onClick={handleDeletePost}>
                    Delete
                  </button>
                )}
              </div>
            </div>

            <div className="comments-section">
              <h3>Comments ({comments.length})</h3>

              {comments.map((c) => (
                <div key={c.id} className="comment">
                  <p>{c.content}</p>
                  <div className="comment-actions">
                    <button className="forum-link-btn" onClick={() => setReportTarget({ type: 'comment', id: c.id })}>
                      Report
                    </button>
                    {c.authorId === currentUser?.id && (
                      <button className="forum-link-btn forum-link-btn--danger" onClick={() => handleDeleteComment(c.id)}>
                        Delete
                      </button>
                    )}
                  </div>
                </div>
              ))}

              <form className="comment-form" onSubmit={handleAddComment}>
                <input
                  type="text"
                  placeholder="Write a comment..."
                  aria-label="Write a comment"
                  value={commentText}
                  onChange={(e) => setCommentText(e.target.value)}
                  maxLength={1000}
                />
                <button type="submit" disabled={posting}>{posting ? '...' : 'Send'}</button>
              </form>
            </div>
          </>
        )}
      </div>

      {reportTarget && (
        <ReportModal
          token={token}
          targetType={reportTarget.type}
          targetId={reportTarget.id}
          onClose={() => setReportTarget(null)}
        />
      )}
    </div>
  );
}