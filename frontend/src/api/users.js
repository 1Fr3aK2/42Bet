// src/api/users.js

const API_URL = '';

// The token is stored in localStorage by App.jsx, so the API helpers can read it
// without every caller having to pass it down.
function authHeaders(token = localStorage.getItem('token')) {
  return {
    'Content-Type': 'application/json',
    ...(token && { Authorization: `Bearer ${token}` }),
  };
}

// NestJS validation errors can come back as an array of messages.
async function buildError(response, fallback) {
  try {
    const error = await response.json();
    const message = Array.isArray(error.message) ? error.message.join(', ') : error.message;
    return new Error(message || fallback);
  } catch {
    return new Error(fallback);
  }
}

export async function registerUser({ username, email, password, wallet }) {
  const response = await fetch(`${API_URL}/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, email, password, wallet }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Registration failed');
  }

  return response.json();
}

// GET /users/me -> the logged-in user (username, avatar, role, ...)
export async function getMe(token) {
  const response = await fetch(`${API_URL}/users/me`, {
    headers: authHeaders(token),
  });

  if (!response.ok) {
    throw await buildError(response, 'Could not load profile');
  }

  return response.json();
}

// Picture types the server accepts as an avatar (backend/src/users/user-rules.ts).
export const AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

// Shrinks the picture to at most 256 x 256 and encodes it as a JPEG data URL.
// A phone photo of several MB becomes a few tens of KB, small enough for the
// server, which refuses requests above 100 KB.
async function toAvatarDataUrl(file) {
  const image = await createImageBitmap(file);
  const scale = Math.min(1, 256 / Math.max(image.width, image.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff'; // JPEG has no transparency
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  // Lower the quality until it fits: busy pictures compress less.
  for (const quality of [0.85, 0.7, 0.5, 0.3]) {
    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    if (dataUrl.length <= 90000) return dataUrl;
  }
  return canvas.toDataURL('image/jpeg', 0.1);
}

// PATCH /users/me -> updates username and/or avatar, returns the updated user
export async function updateUser({ username, avatarFile }) {
  let avatar;
  if (avatarFile) {
    try {
      avatar = await toAvatarDataUrl(avatarFile); // base64 data URL
    } catch {
      throw new Error('This picture could not be read, please choose another one');
    }
  }

  const response = await fetch(`${API_URL}/users/me`, {
    method: 'PATCH',
    headers: authHeaders(),
    body: JSON.stringify({ username, ...(avatar && { avatar }) }),
  });

  if (!response.ok) {
    throw await buildError(response, 'Profile update failed');
  }

  return response.json();
}

// PATCH /users/password -> only currentPassword and newPassword are sent
// (confirmPassword is checked in the form and not part of the backend DTO)
export async function changePassword({ currentPassword, newPassword }) {
  const response = await fetch(`${API_URL}/users/password`, {
    method: 'PATCH',
    headers: authHeaders(),
    body: JSON.stringify({ currentPassword, newPassword }),
  });

  if (!response.ok) {
    throw await buildError(response, 'Password change failed');
  }

  return response.json();
}

// GET /users -> every user (admin only)
export async function getUsers(token) {
  const response = await fetch(`${API_URL}/users`, {
    headers: authHeaders(token),
  });

  if (!response.ok) {
    throw await buildError(response, 'Could not load users');
  }

  return response.json();
}

// PATCH /users/:id/role -> promote to MODERATOR or demote back to USER (admin only)
export async function updateUserRole(token, id, role) {
  const response = await fetch(`${API_URL}/users/${id}/role`, {
    method: 'PATCH',
    headers: authHeaders(token),
    body: JSON.stringify({ role }),
  });

  if (!response.ok) {
    throw await buildError(response, 'Could not change the role');
  }

  return response.json();
}