import { useState } from 'react';
import { createReport } from '../../api/forum';

export default function ReportModal({ token, targetType, targetId, onClose }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await createReport(token, { targetType, targetId, reason });
      setDone(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Report {targetType}</h2>
        {done ? (
          <p>Thanks — this has been reported to the moderators.</p>
        ) : (
          <form onSubmit={handleSubmit}>
            <textarea
              placeholder="Why are you reporting this?"
              aria-label="Reason for the report"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={500}
              rows={4}
              required
            />
            {error && <div className="modal-error">{error}</div>}
            <button type="submit" disabled={loading}>{loading ? 'Submitting...' : 'Submit report'}</button>
          </form>
        )}
        <button className="modal-close" onClick={onClose}>×</button>
      </div>
    </div>
  );
}