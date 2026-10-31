// src/api/analytics.js

// GET /users/me/analytics -> statistics of the logged-in user's bets.
// Empty filters are left out of the query string.
export async function getAnalytics(filters, token = localStorage.getItem('token')) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== '' && value !== null && value !== undefined) params.set(key, value);
  }

  const response = await fetch(`/users/me/analytics?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    let message = 'Could not load your analytics';
    try {
      const error = await response.json();
      message = (Array.isArray(error.message) ? error.message.join(', ') : error.message) || message;
    } catch {
      // keep the default message
    }
    throw new Error(message);
  }

  return response.json();
}
