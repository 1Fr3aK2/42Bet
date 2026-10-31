import { useState, useEffect, useCallback } from 'react';
import { getReports, resolveReport, getPendingContent, reviewContent } from '../../api/forum';

const TABS = [
  { value: 'pending', label: 'Reports' },
  { value: 'flagged', label: 'Auto-flagged' },
  { value: 'resolved', label: 'Resolved' },
];

function formatDate(value) {
  return value ? new Date(value).toLocaleString() : '';
}

// Moderators and admins: review reported posts/comments and resolve them.
export default function ModerationPage({ token, onClose }) {
  const [tab, setTab] = useState('pending');
  const [reports, setReports] = useState([]);
  const [flagged, setFlagged] = useState([]); // posts/comments held by auto-moderation
  const [flaggedCount, setFlaggedCount] = useState(null); // shown on the tab
  const [notes, setNotes] = useState({}); // report id / flagged item key -> moderator note
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      if (tab === 'flagged') {
        const { posts, comments } = await getPendingContent(token);
        const items = [
          ...posts.map((p) => ({ ...p, type: 'post' })),
          ...comments.map((c) => ({ ...c, type: 'comment' })),
        ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        setFlagged(items);
        setFlaggedCount(items.length);
      } else {
        setReports(await getReports(token, tab));
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [token, tab]);

  useEffect(() => {
    load();
  }, [load]);

  // Fill in the count on the "Auto-flagged" tab as soon as the page opens
  useEffect(() => {
    getPendingContent(token)
      .then(({ posts, comments }) => setFlaggedCount(posts.length + comments.length))
      .catch(() => {});
  }, [token]);

  async function handleResolve(report, action) {
    if (
      action === 'remove' &&
      !confirm(`Remove this ${report.targetType}? It will no longer be visible to anyone.`)
    ) {
      return;
    }

    setBusyId(report.id);
    setError('');
    try {
      await resolveReport(token, report.id, {
        action,
        note: (notes[report.id] || '').trim(),
      });
      // Resolved reports leave the "Pending" list straight away.
      setReports((rs) => rs.filter((r) => r.id !== report.id));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  async function handleReview(item, action) {
    if (
      action === 'remove' &&
      !confirm(`Remove this ${item.type}? It will no longer be visible to anyone.`)
    ) {
      return;
    }

    const key = `${item.type}-${item.id}`;
    setBusyId(key);
    setError('');
    try {
      await reviewContent(token, item.type, item.id, {
        action,
        note: (notes[key] || '').trim(),
      });
      setFlagged((fs) => fs.filter((f) => !(f.type === item.type && f.id === item.id)));
      setFlaggedCount((n) => (n === null ? n : Math.max(0, n - 1)));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  const isFlaggedTab = tab === 'flagged';
  const list = isFlaggedTab ? flagged : reports;

  return (
    <div className="settings-page forum-page">
      <button className="settings-close" onClick={onClose}>×</button>

      <div className="forum-container">
        <div className="forum-header">
          <h1>Moderation</h1>
        </div>

        <div className="mod-tabs">
          {TABS.map((t) => (
            <button
              key={t.value}
              className={`mod-tab ${tab === t.value ? 'active' : ''}`}
              onClick={() => setTab(t.value)}
            >
              {t.label}
              {t.value === 'flagged' && flaggedCount > 0 && (
                <span className="mod-tab-count">{flaggedCount}</span>
              )}
            </button>
          ))}
        </div>

        {error && <div className="modal-error">{error}</div>}

        {loading ? (
          <div className="forum-empty">Loading...</div>
        ) : list.length === 0 ? (
          <div className="forum-empty">
            {tab === 'pending' && 'No pending reports. All clear!'}
            {tab === 'flagged' && 'Nothing flagged by the automatic moderation.'}
            {tab === 'resolved' && 'No resolved reports yet.'}
          </div>
        ) : isFlaggedTab ? (
          <div className="forum-list">
            {flagged.map((item) => {
              const key = `${item.type}-${item.id}`;
              return (
                <FlaggedCard
                  key={key}
                  item={item}
                  note={notes[key] || ''}
                  onNoteChange={(value) => setNotes((n) => ({ ...n, [key]: value }))}
                  busy={busyId === key}
                  onReview={(action) => handleReview(item, action)}
                />
              );
            })}
          </div>
        ) : (
          <div className="forum-list">
            {reports.map((report) => (
              <ReportCard
                key={report.id}
                report={report}
                note={notes[report.id] || ''}
                onNoteChange={(value) => setNotes((n) => ({ ...n, [report.id]: value }))}
                busy={busyId === report.id}
                onResolve={(action) => handleResolve(report, action)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// A post or comment the automatic moderation held back for a human decision.
function FlaggedCard({ item, note, onNoteChange, busy, onReview }) {
  const author = item.authorUsername || `user #${item.authorId}`;
  const reasons = Array.isArray(item.moderationReasons) ? item.moderationReasons : [];
  const score =
    typeof item.moderationScore === 'number' ? item.moderationScore.toFixed(2) : null;

  return (
    <div className="report-card">
      <div className="report-card-head">
        <span className="report-type">{item.type}</span>
        <span>{formatDate(item.createdAt)}</span>
      </div>

      <div className="report-target">
        {item.type === 'post' && <h3>{item.title}</h3>}
        {item.type === 'comment' && item.postTitle && (
          <div className="report-reason-label">On post: {item.postTitle}</div>
        )}
        <p className="report-target-content">{item.content}</p>
        <div className="report-target-meta">
          <span>by {author}</span>
          <span className="post-badge post-badge--pending">awaiting review</span>
        </div>
      </div>

      <div>
        <div className="report-reason-label">
          Flagged automatically{score && ` · score ${score}`}
        </div>
        {reasons.length > 0 ? (
          <div className="flag-reasons">
            {reasons.map((reason) => (
              <span className="flag-reason" key={reason}>{reason}</span>
            ))}
          </div>
        ) : (
          <p className="report-reason">No reason recorded.</p>
        )}
      </div>

      <textarea
        className="report-note-input"
        placeholder="Note for the moderation log (optional)"
        aria-label="Note for the moderation log (optional)"
        value={note}
        onChange={(e) => onNoteChange(e.target.value)}
        maxLength={500}
        rows={2}
      />
      <div className="report-actions">
        <button className="mod-btn" disabled={busy} onClick={() => onReview('approve')}>
          Approve (make visible)
        </button>
        <button
          className="mod-btn mod-btn--danger"
          disabled={busy}
          onClick={() => onReview('remove')}
        >
          Remove {item.type}
        </button>
      </div>
    </div>
  );
}

function ReportCard({ report, note, onNoteChange, busy, onResolve }) {
  const { target } = report;
  const isPending = report.status === 'pending';
  const missing = !target; // the author deleted it after it was reported
  const alreadyRemoved = target?.status === 'removed';
  const author = target ? target.authorUsername || `user #${target.authorId}` : '';
  const reporter = report.reporterUsername || `user #${report.reporterId}`;
  const moderator = report.moderatorUsername || `user #${report.moderatorId}`;

  return (
    <div className="report-card">
      <div className="report-card-head">
        <span className="report-type">{report.targetType}</span>
        <span>{formatDate(report.createdAt)}</span>
      </div>

      {missing ? (
        <div className="report-target report-target--missing">
          This {report.targetType} no longer exists (its author deleted it).
        </div>
      ) : (
        <div className="report-target">
          {report.targetType === 'post' && <h3>{target.title}</h3>}
          <p className="report-target-content">{target.content}</p>
          <div className="report-target-meta">
            <span>by {author}</span>
            <span className={`post-badge post-badge--${target.status}`}>{target.status}</span>
          </div>
        </div>
      )}

      <div>
        <div className="report-reason-label">Reported by {reporter}</div>
        <p className="report-reason">{report.reason}</p>
      </div>

      {isPending ? (
        <>
          <textarea
            className="report-note-input"
            placeholder="Note for the moderation log (optional)"
            aria-label="Note for the moderation log (optional)"
            value={note}
            onChange={(e) => onNoteChange(e.target.value)}
            maxLength={500}
            rows={2}
          />
          <div className="report-actions">
            {missing && (
              <button className="mod-btn" disabled={busy} onClick={() => onResolve('dismiss')}>
                Close report
              </button>
            )}

            {alreadyRemoved && (
              <button className="mod-btn" disabled={busy} onClick={() => onResolve('remove')}>
                Close report (already removed)
              </button>
            )}

            {!missing && !alreadyRemoved && (
              <>
                <button className="mod-btn" disabled={busy} onClick={() => onResolve('dismiss')}>
                  Dismiss report
                </button>
                <button
                  className="mod-btn mod-btn--danger"
                  disabled={busy}
                  onClick={() => onResolve('remove')}
                >
                  Remove {report.targetType}
                </button>
              </>
            )}
          </div>
        </>
      ) : (
        <div className="report-resolution">
          <strong>{report.resolution === 'remove' ? 'Content removed' : 'Dismissed'}</strong>
          {' '}by {moderator} on {formatDate(report.reviewedAt)}
          {report.moderatorNote && (
            <p className="report-resolution-note">“{report.moderatorNote}”</p>
          )}
        </div>
      )}
    </div>
  );
}
