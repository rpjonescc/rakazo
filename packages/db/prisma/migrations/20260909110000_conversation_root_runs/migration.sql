ALTER TABLE "runs" ADD COLUMN "conversationRootMessageId" TEXT;

CREATE INDEX "runs_conversationRootMessageId_idx" ON "runs"("conversationRootMessageId");

ALTER TABLE "runs"
ADD CONSTRAINT "runs_conversationRootMessageId_fkey"
FOREIGN KEY ("conversationRootMessageId") REFERENCES "messages"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
