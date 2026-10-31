# Forum Module

The Forum module provides authenticated forum functionality, including posts,
comments, reports, automatic rule-based content moderation, manual moderation,
and advanced post search.

All Forum endpoints require JWT authentication. Some moderation and reporting
endpoints additionally require the `MODERATOR` or `ADMIN` role.

## Authentication and authorization

Forum requests use the existing JWT authentication system.

Authenticated requests must include:

```http
Authorization: Bearer <access_token>
```

The authenticated user is used by the backend to determine ownership and
permissions. The frontend must not provide `authorId`, `reporterId`, or
`moderatorId` when creating or moderating content.

Available roles:

- `USER`
- `MODERATOR`
- `ADMIN`

Regular authenticated users can create and manage their own posts and comments
and can report visible content.

Moderators and administrators can additionally access reports, pending content,
manual moderation actions, and moderation logs.

---

## Rate limiting

Write actions on the forum are rate-limited per authenticated user, on top of
the general IP-based limit nginx applies to all of `/forum` (30 requests/second
per IP — see `NGINX_CONFIG.md`). The per-user limits below are what actually
bounds abusive behavior from a single account, since the IP-based limit alone
doesn't distinguish one user making many requests from several users sharing
a network:

| Action | Limit | Window |
|---|---|---|
| `POST /forum/posts` | 5 requests | 10 minutes |
| `POST /forum/posts/:id/comments` | 20 requests | 10 minutes |
| `POST /forum/reports` | 10 requests | 1 hour |

Each limit is keyed per `userId` (taken from the JWT, never from the request),
so one user's activity never affects another's. Exceeding a limit returns:

```http
HTTP 429 Too Many Requests
```

with a message identifying which action was throttled. The limit resets
automatically once the time window elapses — there is no manual unblock
needed, and no action required by the user beyond waiting.

Read endpoints (`GET /forum/posts`, `GET /forum/posts/:id`,
`GET /forum/posts/:id/comments`) are not subject to a per-user limit, only the
general IP-based one.

Implementation detail (Redis-backed, atomic counters via `RateLimiterService`,
shared with the login and Admin Public API rate limits) is documented in
`RATE_LIMITING.md` and `SECURITY_REPORT.md` §4, not duplicated here — this
section only covers what a frontend integrator needs to know: the limits
themselves and the `429` response shape.

---

## Posts

### List posts and advanced search

```http
GET /forum/posts
```

Returns visible posts only.

The endpoint supports text search, filtering, sorting, and pagination.

### Query parameters

| Parameter | Type | Default | Description |
|---|---|---|---|
| `search` | string | — | Case-insensitive search in post title and content |
| `authorId` | positive integer | — | Filter posts by author |
| `dateFrom` | ISO 8601 date | — | Filter posts created on or after this date |
| `dateTo` | ISO 8601 date | — | Filter posts created on or before this date |
| `sortBy` | string | `createdAt` | Sort by `createdAt`, `updatedAt`, or `title` |
| `order` | string | `desc` | Sort direction: `asc` or `desc` |
| `page` | integer | `1` | Page number, starting at 1 |
| `limit` | integer | `10` | Results per page, from 1 to 100 |

`dateFrom` must be earlier than or equal to `dateTo`.

Example:

```http
GET /forum/posts?search=bitcoin&authorId=1&sortBy=createdAt&order=desc&page=1&limit=10
```

Response format:

```json
{
  "data": [
    {
      "id": 1,
      "title": "Bitcoin discussion",
      "content": "A normal post about market trends.",
      "status": "visible",
      "authorId": 1
    }
  ],
  "meta": {
    "page": 1,
    "limit": 10,
    "total": 1,
    "totalPages": 1
  }
}
```

Search parameters can be combined.

Posts with `pending` or `removed` status are never returned by this endpoint.

### Get a post

```http
GET /forum/posts/:id
```

Returns the post identified by `id`.

### Create a post

```http
POST /forum/posts
```

Body:

```json
{
  "title": "My first post",
  "content": "This is the content of the post."
}
```

Validation:

- `title` is required and has a maximum length of 100 characters.
- `content` is required and has a maximum length of 1000 characters.
- `authorId` is obtained from the authenticated user.

New posts are processed by automatic moderation before being stored.

Subject to the per-user rate limit — see "Rate limiting" above.

### Update a post

```http
PATCH /forum/posts/:id
```

Body may contain:

```json
{
  "title": "Updated title",
  "content": "Updated content"
}
```

Only the author can update a post.

The resulting complete post is processed again by automatic moderation after
an edit.

A post with `removed` status cannot be edited.

### Delete a post

```http
DELETE /forum/posts/:id
```

Only the author can delete a post.

---

## Comments

### List comments

```http
GET /forum/posts/:id/comments
```

Returns visible comments for the selected post, ordered from oldest to newest.

### Create a comment

```http
POST /forum/posts/:id/comments
```

Body:

```json
{
  "content": "This is a comment."
}
```

Validation:

- `content` is required and has a maximum length of 1000 characters.
- `authorId` is obtained from the authenticated user.

Comments can only be added to visible posts.

New comments are processed by automatic moderation.

Subject to the per-user rate limit — see "Rate limiting" above.

### Update a comment

```http
PATCH /forum/comments/:id
```

Body:

```json
{
  "content": "Updated comment."
}
```

Only the author can update a comment.

Edited comments are processed again by automatic moderation.

A comment with `removed` status cannot be edited.

### Delete a comment

```http
DELETE /forum/comments/:id
```

Only the author can delete a comment.

---

## Reports

Authenticated users can report visible posts or comments.

### Create a report

```http
POST /forum/reports
```

Body:

```json
{
  "targetType": "post",
  "targetId": 1,
  "reason": "Reason for reporting this content."
}
```

`targetType` must be either `post` or `comment`.

A user cannot have more than one pending report for the same content.

Content that is no longer visible cannot be reported.

Subject to the per-user rate limit — see "Rate limiting" above.

### List reports

Requires the `MODERATOR` or `ADMIN` role.

```http
GET /forum/reports
```

An optional `status` query parameter can be used to filter reports.

Example:

```http
GET /forum/reports?status=pending
```

### Resolve a report

Requires the `MODERATOR` or `ADMIN` role.

```http
PATCH /forum/reports/:id/resolve
```

Body:

```json
{
  "action": "remove",
  "note": "Content violates forum rules."
}
```

Available actions:

- `dismiss` — resolve the report without removing the content.
- `remove` — resolve the report and mark the reported content as removed.

Resolving a report creates a moderation log.

---

## Content moderation

### Automatic rule-based moderation

Posts and comments are automatically analyzed when they are created or edited.

The currently active moderation engine is rule-based.

The moderation architecture uses dependency injection through a common
moderation engine interface, allowing the active implementation to be replaced
without changing the Forum service.

The current engine evaluates indicators including:

- possible financial scams;
- spam;
- abusive language;
- external links;
- excessive uppercase text;
- excessive character repetition.

The analysis produces:

```json
{
  "decision": "flagged",
  "score": 0.4,
  "reasons": [
    "Possible financial scam"
  ]
}
```

Possible decisions are:

| Score | Decision | Result |
|---|---|---|
| `< 0.3` | `approved` | Content becomes `visible` |
| `>= 0.3` and `< 0.7` | `flagged` | Content becomes `pending` |
| `>= 0.7` | `rejected` | Request is rejected |

Rejected content is not stored as the result of the attempted creation or edit.

### Pending content

Requires the `MODERATOR` or `ADMIN` role.

```http
GET /forum/moderation/pending
```

Returns posts and comments waiting for manual review.

### Review a pending post

Requires the `MODERATOR` or `ADMIN` role.

```http
PATCH /forum/moderation/posts/:id/review
```

### Review a pending comment

Requires the `MODERATOR` or `ADMIN` role.

```http
PATCH /forum/moderation/comments/:id/review
```

Review body:

```json
{
  "action": "approve",
  "note": "Content reviewed."
}
```

Available actions:

- `approve` — makes the content visible.
- `remove` — marks the content as removed.

Manual reviews create moderation logs.

### Moderation logs

Requires the `MODERATOR` or `ADMIN` role.

```http
GET /forum/moderation/logs
```

Returns moderation actions ordered from newest to oldest.

---

## Content states

Posts and comments use the following states:

| State | Meaning |
|---|---|
| `visible` | Available in normal Forum listings |
| `pending` | Flagged by automatic moderation and waiting for manual review |
| `removed` | Removed through moderation |

Removed content remains stored but is excluded from normal visible listings.

Removed posts and comments cannot be restored by their authors through an edit.

Reports use:

- `pending`
- `resolved`

---

## HTTP errors

Common responses include:

| Status | Meaning |
|---|---|
| `400 Bad Request` | Invalid input, invalid search parameters, rejected content, or invalid moderation operation |
| `401 Unauthorized` | Missing or invalid authentication |
| `403 Forbidden` | Authenticated user lacks the required role or does not own the resource |
| `404 Not Found` | Requested resource does not exist |
| `409 Conflict` | Operation conflicts with the current resource state |
| `429 Too Many Requests` | Per-user rate limit exceeded on `POST /forum/posts`, `POST /forum/posts/:id/comments`, or `POST /forum/reports` — see "Rate limiting" above |

---

## Frontend integration

The Forum API is intended to be consumed by the application frontend.

User identity is derived from the JWT. The frontend must not send ownership or
moderation identity fields such as `authorId`, `reporterId`, or `moderatorId`.

The post listing endpoint uses a paginated response:

```http
GET /forum/posts
```

```json
{
  "data": [],
  "meta": {
    "page": 1,
    "limit": 10,
    "total": 0,
    "totalPages": 0
  }
}
```

Frontend code consuming this endpoint must therefore read the post collection
from `data` and use `meta` for pagination controls.

The frontend should handle `429` responses from the rate-limited write
endpoints gracefully (e.g. disabling the submit button and surfacing the
server's message) rather than retrying immediately, since the limit will not
have cleared yet.