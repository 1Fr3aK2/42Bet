# Users Module (`backend/src/users`)

## What it does

Manages user accounts: creation, listing, profile updates, password changes,
and role assignment. All write operations that affect other users are
restricted to admins; users can only modify their own profile and password.

## Endpoints

### `POST /users` — Create a user

**Auth**: none (public — used during registration).

#### Request body

```json
{
  "username": "pedro",
  "email": "pedro@test.com",
  "password": "12345678",
  "wallet": 0,
  "avatar": "https://…"
}
```

`CreateUserDto` validation:

| Field      | Type   | Constraints                   |
|------------|--------|-------------------------------|
| `username` | string | required, 3 to 20 letters, digits, `_`, `.` or `-` (no `@`, see `user-rules.ts`) |
| `email`    | string | required, valid email format  |
| `password` | string | required, ≥ 8 characters      |
| `wallet`   | number | optional, ignored: new accounts always start with 1000 (set by the server) |
| `avatar`   | string | optional, PNG/JPEG/GIF/WebP image as a data URL, ≤ 100 000 characters |

Password is hashed with **bcrypt** (10 rounds) before storage.

#### Response `201`

```json
{
  "id": 1,
  "username": "pedro",
  "email": "pedro@test.com",
  "role": "USER",
  "avatar": null,
  "wallet": 1000,
  "wins": 0,
  "losses": 0,
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-01-01T00:00:00.000Z"
}
```

#### Error `409 Conflict`

Returned when `username` or `email` already exists.

```json
{ "message": "Username or email already exists", "statusCode": 409 }
```

---

### `GET /users` — List all users

**Auth**: `JwtAuthGuard` + `RolesGuard` — requires role `ADMIN`.

Returns all users with full public fields (no passwords).

```json
[
  {
    "id": 1,
    "username": "pedro",
    "email": "pedro@test.com",
    "role": "USER",
    "avatar": null,
    "wallet": 0,
    "wins": 0,
    "losses": 0,
    "createdAt": "…",
    "updatedAt": "…"
  }
]
```

---

### `PATCH /users/:id/role` — Change a user's role

**Auth**: `JwtAuthGuard` + `RolesGuard` — requires role `ADMIN`.

#### Request body

```json
{ "role": "MODERATOR" }
```

`UpdateUserRoleDto` validation:

| Field  | Type   | Constraints                       |
|--------|--------|-----------------------------------|
| `role` | string | required, one of `USER`, `MODERATOR` |

**Rules enforced by the service:**
- Target user must exist — `404` otherwise.
- An `ADMIN`'s role cannot be changed through this endpoint — `400` if
  the target is already an admin.
- `role` must be `USER` or `MODERATOR` (admins cannot be created this way).

#### Response `200`

```json
{ "id": 2, "username": "joao", "email": "joao@test.com", "role": "MODERATOR" }
```

---

### `PATCH /users/me` — Update own profile

**Auth**: `JwtAuthGuard` — any authenticated user.

Allows a user to change their own `username` and/or `avatar`.

#### Request body

```json
{
  "username": "new_name",
  "avatar": "https://…"
}
```

`UpdateMeDto` validation:

| Field      | Type   | Constraints                |
|------------|--------|----------------------------|
| `username` | string | optional, same rule as in `CreateUserDto` |
| `avatar`   | string | optional, same rule as in `CreateUserDto` (the frontend resizes the picture to 256 x 256 first) |

#### Response `200`

Full user object (same shape as `POST /users` response).

#### Error `409 Conflict`

Returned when the new `username` is already taken.

---

### `PATCH /users/password` — Change own password

**Auth**: `JwtAuthGuard` — any authenticated user.

#### Request body

```json
{
  "currentPassword": "oldpassword",
  "newPassword": "newpassword123"
}
```

`UpdatePasswordDto` validation:

| Field             | Type   | Constraints          |
|-------------------|--------|----------------------|
| `currentPassword` | string | required             |
| `newPassword`     | string | required, ≥ 8 chars  |

**Rules enforced by the service:**
- User must exist — `404` otherwise.
- `currentPassword` must match the stored bcrypt hash — `400` if incorrect.
- `newPassword` is hashed with bcrypt (10 rounds) before storage.

#### Response `200`

```json
{ "message": "Password updated successfully" }
```

---

## Available roles

| Role        | Description                                    |
|-------------|------------------------------------------------|
| `USER`      | Default role — regular player                  |
| `MODERATOR` | Can access content moderation endpoints        |
| `ADMIN`     | Full access, including user listing and role management |

---

## Error reference

| Status | Meaning                                              |
|--------|------------------------------------------------------|
| 400    | Validation error or business rule violation          |
| 401    | Missing or invalid JWT                               |
| 403    | Authenticated but insufficient role                  |
| 404    | User not found                                       |
| 409    | Username or email conflict                           |

---

## Module structure

```
users/
├── users.module.ts           # NestJS module declaration
├── users.controller.ts       # Route handlers
├── users.service.ts          # Business logic + Prisma calls
├── create-user.dto.ts        # DTO for POST /users
├── update-me.dto.ts          # DTO for PATCH /users/me
├── update-password.dto.ts    # DTO for PATCH /users/password
└── update-user-role.dto.ts   # DTO for PATCH /users/:id/role
```
