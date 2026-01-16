-- AlterTable
ALTER TABLE "MpesaTransaction" ADD COLUMN     "callbackReceivedAt" TIMESTAMP(3),
ADD COLUMN     "initiatedAt" TIMESTAMP(3),
ADD COLUMN     "transactionDesc" TEXT;

-- CreateIndex
CREATE INDEX "MpesaTransaction_checkoutRequestId_status_idx" ON "MpesaTransaction"("checkoutRequestId", "status");
