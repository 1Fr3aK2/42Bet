// Rules shared by the registration (create-user.dto.ts) and the profile update
// (update-me.dto.ts), so both accept exactly the same usernames and avatars.

// 3 to 20 letters, digits, "_", "." or "-". No spaces and no "@": the login
// accepts a username or an email, and the "@" is what tells them apart.
export const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{3,20}$/;
export const USERNAME_MESSAGE =
  'username must be 3 to 20 characters: letters, digits, "_", "." or "-"';

// The avatar is a picture sent as a data URL ("data:image/png;base64,...").
// The frontend shrinks it to 256 x 256 before sending it (a few tens of KB);
// anything that is not a PNG, JPEG, GIF or WebP image is refused.
export const AVATAR_PATTERN = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
export const AVATAR_MESSAGE = 'avatar must be a PNG, JPEG, GIF or WebP image';
export const AVATAR_MAX_LENGTH = 100000;
