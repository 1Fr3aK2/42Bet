
// Rules shared by registration and profile updates.

export const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{3,20}$/;

export const USERNAME_MESSAGE = 'username must be 3 to 20 characters: letters, digits, "_", "." or "-"';

// Maximum encoded avatar length (Base64 data URL).
export const AVATAR_MAX_LENGTH = 100000;
