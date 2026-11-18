# Populate the 42Bet Forum Using HTTP Requests

Copy the contents of the `scripts/` directory into the `scripts/` directory of the Transcendence repository, keeping the `forum-data/` directory structure intact. This does not replace the backend, modify application code, or access the database directly.

From the project root:

```bash
chmod +x scripts/populate-forum.sh
./scripts/populate-forum.sh pt
# or
./scripts/populate-forum.sh en
```

If no argument is provided, or if the language is neither `pt` nor `en`, the script displays the correct usage and exits **without making any HTTP requests**.

**Dependencies on the machine running the script:** `bash`, `curl`, `jq`.

**Default address:** `https://localhost`, using `curl -k` to accept the local TLS certificate. If the API is exposed at a different address:

```bash
API_BASE_URL='https://localhost/api' ./scripts/populate-forum.sh pt
```

This override is only needed if the API actually uses that prefix. Before creating any content, the script checks that `GET /forum/posts` without a JWT returns HTTP 401.

**Data created:** 5 demo accounts (`demo_*`), 20 posts, and 60 comments per language. The five accounts are reused on subsequent runs and across both languages. Each account creates 4 posts and 12 comments, staying below the forum's rate limits (5 posts and 20 comments per 10 minutes per user). The five login attempts also remain below the Nginx limit of 10 requests per minute per IP, provided there have been no other recent attempts.

**Demo account password:** `ForumDemo2026!`. It is intended only for local development/demo environments. You can change it before the first run with `DEMO_PASSWORD='AnotherTestPassword' ./scripts/populate-forum.sh pt`. To reuse the accounts, always use the same password. Do not use demo accounts as real user accounts.

**Running the script again:** the script handles HTTP 409 when creating accounts, logs in to existing accounts, checks posts by title and author, and checks comments by content and author. This prevents duplicates on subsequent runs, as long as the API makes the previous content available and the data files have not been changed.

**Report:** the script prints progress to the terminal and creates a log in `scripts/logs/`, which is ignored by Git. It counts new, existing, pending, and failed accounts, logins, posts, and comments. It displays HTTP status codes and failure messages. If any content is not visible or cannot be created, the script exits with a non-zero status code.

**Moderation:** the content is neutral and designed to appear with the `visible` status, but it has not been checked against the actual moderation engine in this version. The script detects posts/comments with other statuses and flags them in the summary. It does not attempt to add comments to posts that are not visible.

**Validation:** the script was tested against a simulated API in three scenarios: an initial run, a repeat run without duplicates, and a run in the second language reusing the same accounts. **It has not yet been run against your actual installation**, which may require adjusting `API_BASE_URL` or behavior that could not be determined from the supplied files.
