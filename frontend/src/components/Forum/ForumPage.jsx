import { useState, useEffect, useCallback } from 'react';
import { getPosts } from '../../api/forum';
import PostCard from './PostCard';
import CreatePostModal from './CreatePostModal';
import PostDetail from './PostDetail';

const SORT_OPTIONS = [
  { value: 'createdAt-desc', label: 'Newest first', sortBy: 'createdAt', order: 'desc' },
  { value: 'createdAt-asc', label: 'Oldest first', sortBy: 'createdAt', order: 'asc' },
  { value: 'updatedAt-desc', label: 'Recently updated', sortBy: 'updatedAt', order: 'desc' },
  { value: 'title-asc', label: 'Title (A–Z)', sortBy: 'title', order: 'asc' },
];

export default function ForumPage({ token, currentUser, onClose }) {
  const [posts, setPosts] = useState([]);
  const [meta, setMeta] = useState({ page: 1, totalPages: 1 });
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('createdAt-desc');
  const [myPostsOnly, setMyPostsOnly] = useState(false);
  const [showMoreFilters, setShowMoreFilters] = useState(false);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [selectedPostId, setSelectedPostId] = useState(null);

  const loadPosts = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const sortConfig = SORT_OPTIONS.find((s) => s.value === sort);
      const result = await getPosts(token, {
        search: search || undefined,
        authorId: myPostsOnly ? currentUser?.id : undefined,
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
        sortBy: sortConfig.sortBy,
        order: sortConfig.order,
        page,
        limit: 10,
      });
      setPosts(result.data);
      setMeta(result.meta);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [token, search, sort, myPostsOnly, dateFrom, dateTo, page, currentUser]);

  useEffect(() => {
    loadPosts();
  }, [loadPosts]);

  if (selectedPostId) {
    return (
      <PostDetail
        token={token}
        currentUser={currentUser}
        postId={selectedPostId}
        onBack={() => setSelectedPostId(null)}
        onClose={onClose}
      />
    );
  }

  return (
    <div className="settings-page forum-page">
      <button className="settings-close" onClick={onClose}>×</button>

      <div className="forum-container">
        <div className="forum-header">
          <h1>Forum</h1>
          <button className="settings-save-btn" onClick={() => setShowCreate(true)}>
            New post
          </button>
        </div>

        <input
          className="forum-search"
          type="text"
          placeholder="Search posts..."
          aria-label="Search posts"
          value={search}
          onChange={(e) => { setPage(1); setSearch(e.target.value); }}
        />

        <div className="forum-filters">
          <select
            className="forum-select"
            value={sort}
            aria-label="Sort posts"
            onChange={(e) => { setPage(1); setSort(e.target.value); }}
          >
            {SORT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>

          <label className="forum-checkbox">
            <input
              type="checkbox"
              checked={myPostsOnly}
              onChange={(e) => { setPage(1); setMyPostsOnly(e.target.checked); }}
            />
            My posts only
          </label>

          <button
            type="button"
            className="forum-link-btn"
            onClick={() => setShowMoreFilters((s) => !s)}
          >
            {showMoreFilters ? 'Hide date filter' : 'Filter by date'}
          </button>
        </div>

        {showMoreFilters && (
          <div className="forum-filters forum-filters--dates">
            <label className="forum-date-field">
              From
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => { setPage(1); setDateFrom(e.target.value); }}
              />
            </label>
            <label className="forum-date-field">
              To
              <input
                type="date"
                value={dateTo}
                onChange={(e) => { setPage(1); setDateTo(e.target.value); }}
              />
            </label>
            {(dateFrom || dateTo) && (
              <button
                type="button"
                className="forum-link-btn"
                onClick={() => { setPage(1); setDateFrom(''); setDateTo(''); }}
              >
                Clear dates
              </button>
            )}
          </div>
        )}

        {error && <div className="modal-error">{error}</div>}

        {loading ? (
          <div className="forum-empty">Loading...</div>
        ) : posts.length === 0 ? (
          <div className="forum-empty">
            {myPostsOnly || search || dateFrom || dateTo
              ? 'No posts match these filters.'
              : 'No posts yet. Be the first to post!'}
          </div>
        ) : (
          <div className="forum-list">
            {posts.map((post) => (
              <PostCard
                key={post.id}
                post={post}
                isOwn={post.authorId === currentUser?.id}
                onClick={() => setSelectedPostId(post.id)}
              />
            ))}
          </div>
        )}

        {meta.totalPages > 1 && (
          <div className="forum-pagination">
            <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>‹ Prev</button>
            <span>Page {meta.page} of {meta.totalPages}</span>
            <button disabled={page >= meta.totalPages} onClick={() => setPage((p) => p + 1)}>Next ›</button>
          </div>
        )}
      </div>

      {showCreate && (
        <CreatePostModal
          token={token}
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); loadPosts(); }}
        />
      )}
    </div>
  );
}