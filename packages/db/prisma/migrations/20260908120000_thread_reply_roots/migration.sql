ALTER TABLE "messages" ADD COLUMN "threadRootMessageId" TEXT;

CREATE INDEX "messages_threadId_threadRootMessageId_seq_idx"
ON "messages"("threadId", "threadRootMessageId", "seq");

ALTER TABLE "messages"
ADD CONSTRAINT "messages_threadRootMessageId_fkey"
FOREIGN KEY ("threadRootMessageId") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;
