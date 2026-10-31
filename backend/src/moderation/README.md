# Moderation Module (`backend/src/moderation`)

## What it does

Provides a text-analysis endpoint that moderators and admins can call to
evaluate whether a piece of text (e.g. a forum post or chat message) should
be approved, flagged for review, or rejected outright.

The analysis is delegated to a pluggable **engine** so the underlying
algorithm can be swapped without touching the controller or service.

## Endpoint

```
POST /forum/moderation/analyze
```

**Guards**: `JwtAuthGuard` + `RolesGuard` — requires role `MODERATOR` or
`ADMIN`.

### Request body

```json
{
  "text": "The content to evaluate (max 5 000 characters)"
}
```

Validated by `AnalyzeTextDto`:

| Field | Type   | Constraints                    |
|-------|--------|-------------------------------|
| `text`| string | required, non-empty, ≤ 5 000 chars |

### Response

```json
{
  "decision": "approved" | "flagged" | "rejected",
  "score": 0.0,
  "reasons": ["…"]
}
```

| Field      | Type     | Description                                                  |
|------------|----------|--------------------------------------------------------------|
| `decision` | string   | Final verdict: `approved`, `flagged`, or `rejected`          |
| `score`    | number   | Accumulated risk score, clamped to `[0, 1]`                  |
| `reasons`  | string[] | Human-readable list of triggered rules (empty if clean)      |

## Architecture

The module uses a **Strategy pattern** through a NestJS injection token:

```
ModerationController
  └─ ModerationService
       └─ MODERATION_ENGINE token  ──►  ModerationEngine (interface)
                                             │
                              ┌──────────────┴──────────────┐
                              │                             │
                  RuleBasedModerationEngine       LlmModerationEngine
                  (active / injected)             (stub — not yet implemented)
```

- **`moderation-engine.token.ts`** — defines the injection token
  `MODERATION_ENGINE`.
- **`moderation-engine.interface.ts`** — `ModerationEngine` interface with a
  single `analyzeText(text: string): ModerationResult` method.
- **`ModerationService`** — thin wrapper that resolves the engine via
  `@Inject(MODERATION_ENGINE)` and calls `analyzeText`.
- **`ModerationModule`** — wires `RuleBasedModerationEngine` as the active
  engine; imports `AuthModule` and `PrismaModule`; exports `ModerationService`
  so other modules (e.g. `ForumModule`) can inject it directly.

## Active engine: `RuleBasedModerationEngine`

Pure, synchronous, dependency-free. Checks several independent rule groups
and accumulates a risk score:

| Rule group              | Trigger condition                                    | Score added |
|-------------------------|------------------------------------------------------|-------------|
| Financial scam          | Matches phrases like "guaranteed profit", "free money", "send me bitcoin", … | +0.40 |
| Spam                    | Matches phrases like "click here", "buy now", "limited offer", … | +0.25 |
| Abusive language        | Matches phrases like "idiot", "kill yourself", …     | +0.50 |
| External link           | Text contains `http://` or `https://`                | +0.20 |
| Excessive uppercase     | > 70 % of letters are uppercase (minimum 10 letters) | +0.15 |
| Excessive repetition    | Any character repeated 6+ times in a row             | +0.15 |

Score is clamped to `1.0`. Decision thresholds:

| Score range | Decision   |
|-------------|------------|
| `< 0.30`    | `approved` |
| `0.30–0.69` | `flagged`  |
| `≥ 0.70`    | `rejected` |

## Stub engine: `LlmModerationEngine`

Implements the same interface but throws `NotImplementedException` on every
call. Registered in the module but **not** currently injected — the active
binding is `RuleBasedModerationEngine`. Intended as the starting point for a
future AI-powered moderation pass.

## Adding a new engine

1. Create a class that implements `ModerationEngine`.
2. Decorate it with `@Injectable()`.
3. In `ModerationModule`, change the `useClass` inside the `MODERATION_ENGINE`
   provider to your new class.

No other files need to change.

## Types (`moderation.types.ts`)

```typescript
export type ModerationDecision = 'approved' | 'flagged' | 'rejected';

export type ModerationResult = {
  decision: ModerationDecision;
  score: number;
  reasons: string[];
};
```
