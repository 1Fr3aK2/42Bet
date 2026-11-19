-- Preserve moderation logs when their moderator account is deleted.

ALTER TABLE "ModerationLog"
  ALTER COLUMN "moderatorId" DROP NOT NULL;

ALTER TABLE "ModerationLog"
  DROP CONSTRAINT "ModerationLog_moderatorId_fkey";

ALTER TABLE "ModerationLog"
  ADD CONSTRAINT "ModerationLog_moderatorId_fkey"
  FOREIGN KEY ("moderatorId")
  REFERENCES "User"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;
