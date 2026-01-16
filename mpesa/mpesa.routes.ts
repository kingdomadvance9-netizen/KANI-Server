import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "../prisma";
import { mpesaService } from "./mpesa.service";
import { validateAndNormalizePhone } from "./phone-validation";
import { validateAmount } from "./amount-validation";

const router = Router();

// ============================================================
// TOP-LEVEL REQUEST LOGGER - Logs EVERY request to M-Pesa routes
// This helps debug if Safaricom's callback is even reaching us
// ============================================================
router.use((req: Request, res: Response, next: NextFunction) => {
  const timestamp = new Date().toISOString();
  console.log("\n" + "=".repeat(70));
  console.log(`🌐 [${timestamp}] INCOMING M-PESA REQUEST`);
  console.log(`   Method: ${req.method}`);
  console.log(`   Path: ${req.path}`);
  console.log(`   Full URL: ${req.originalUrl}`);
  console.log(`   IP: ${req.ip || req.socket.remoteAddress}`);
  console.log(`   Content-Type: ${req.headers["content-type"]}`);
  console.log(`   User-Agent: ${req.headers["user-agent"]}`);

  // For POST requests, log the body
  if (req.method === "POST") {
    console.log(`   Body Type: ${typeof req.body}`);
    console.log(`   Body Empty: ${!req.body || Object.keys(req.body).length === 0}`);
    console.log(`   Body: ${JSON.stringify(req.body, null, 2)}`);
  }
  console.log("=".repeat(70) + "\n");

  next();
});

// Test endpoint to verify callback URL is reachable
router.get("/callback-test", (req: Request, res: Response) => {
  res.json({
    success: true,
    message: "Callback endpoint is reachable",
    timestamp: new Date().toISOString(),
  });
});

/**
 * POST /api/mpesa/simulate-callback
 * DEV ONLY: Simulate a Safaricom callback to test extraction logic
 * Usage: POST with { checkoutRequestId: "ws_CO_xxx", receiptNumber: "ABC123" }
 */
router.post("/simulate-callback", async (req: Request, res: Response) => {
  if (process.env.NODE_ENV === "production" && !process.env.ALLOW_CALLBACK_SIMULATION) {
    return res.status(403).json({ error: "Simulation not allowed in production" });
  }

  const { checkoutRequestId, receiptNumber = "SIM" + Date.now() } = req.body;

  if (!checkoutRequestId) {
    return res.status(400).json({ error: "checkoutRequestId is required" });
  }

  // Find the transaction to get MerchantRequestID
  const transaction = await prisma.mpesaTransaction.findUnique({
    where: { checkoutRequestId },
  });

  if (!transaction) {
    return res.status(404).json({ error: "Transaction not found" });
  }

  // Simulate the exact Safaricom callback payload
  const simulatedPayload = {
    Body: {
      stkCallback: {
        MerchantRequestID: transaction.merchantRequestId,
        CheckoutRequestID: checkoutRequestId,
        ResultCode: 0,
        ResultDesc: "The service request is processed successfully.",
        CallbackMetadata: {
          Item: [
            { Name: "Amount", Value: Number(transaction.amount) },
            { Name: "MpesaReceiptNumber", Value: receiptNumber },
            { Name: "TransactionDate", Value: parseInt(new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)) },
            { Name: "PhoneNumber", Value: parseInt(transaction.phoneNumber) },
          ],
        },
      },
    },
  };

  console.log("🧪 SIMULATING CALLBACK:", JSON.stringify(simulatedPayload, null, 2));

  // Manually invoke the callback logic by making internal request
  const axios = require("axios");
  try {
    const response = await axios.post(
      `http://localhost:${process.env.PORT || 3001}/api/mpesa/callback`,
      simulatedPayload
    );

    // Fetch the updated transaction
    const updated = await prisma.mpesaTransaction.findUnique({
      where: { checkoutRequestId },
    });

    return res.json({
      success: true,
      message: "Callback simulated successfully",
      simulatedPayload,
      updatedTransaction: {
        id: updated?.id,
        status: updated?.status,
        mpesaReceiptNumber: updated?.mpesaReceiptNumber,
        callbackReceivedAt: updated?.callbackReceivedAt,
      },
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

/**
 * NOTE: C2B URL registration is NOT needed for STK Push
 * STK Push includes the callback URL in each request automatically
 */
// ✅ REMOVED: In-memory pendingTransactions Map
// Now using database-first approach - all transactions saved immediately

/**
 * POST /api/mpesa/initiate
 * Initiate M-Pesa payment (STK Push)
 */
router.post("/initiate", async (req: Request, res: Response) => {
  try {
    const { userId, userName, phoneNumber, amount, accountReference } =
      req.body;

    // Validation - Required fields
    if (!userId || !phoneNumber || !amount || !accountReference) {
      return res.status(400).json({
        success: false,
        code: "MISSING_FIELDS",
        message:
          "Missing required fields: userId, phoneNumber, amount, accountReference",
      });
    }

    // Validate and normalize phone number
    const phoneValidation = validateAndNormalizePhone(phoneNumber);
    if (!phoneValidation.valid) {
      return res.status(400).json({
        success: false,
        code: "INVALID_PHONE",
        message: phoneValidation.error,
      });
    }

    // Validate amount (must be integer >= 1)
    const amountValidation = validateAmount(amount);
    if (!amountValidation.valid) {
      return res.status(400).json({
        success: false,
        code: "INVALID_AMOUNT",
        message: amountValidation.error,
      });
    }

    const transactionDesc = `Payment for ${accountReference}`;

    // Initiate STK Push
    const stkResponse = await mpesaService.stkPush(
      phoneValidation.normalized,
      amountValidation.amount,
      accountReference,
      transactionDesc
    );

    // ✅ DATABASE-FIRST: Save transaction IMMEDIATELY with PENDING status
    // This fixes the critical issue where status polling couldn't find transactions
    const transaction = await prisma.mpesaTransaction.create({
      data: {
        userId,
        userName: userName || null,
        phoneNumber: phoneValidation.normalized,
        amount: amountValidation.amount,
        accountReference,
        transactionDesc,
        merchantRequestId: stkResponse.MerchantRequestID,
        checkoutRequestId: stkResponse.CheckoutRequestID,
        status: "PENDING",
        initiatedAt: new Date(),
      },
    });

    console.log(
      `📤 STK Push sent to ${phoneValidation.normalized} for KES ${amountValidation.amount}`
    );
    console.log(`💾 Transaction saved to DB with ID: ${transaction.id}`);

    return res.status(200).json({
      success: true,
      message: "STK Push sent successfully. Please check your phone.",
      data: {
        transactionId: transaction.id,
        checkoutRequestId: transaction.checkoutRequestId,
        merchantRequestId: transaction.merchantRequestId,
      },
    });
  } catch (error: any) {
    console.error("❌ M-Pesa Initiate Error:", error);
    return res.status(500).json({
      success: false,
      code: "INITIATE_ERROR",
      message: error.message || "Failed to initiate payment",
    });
  }
});

/**
 * POST /api/mpesa/callback
 * M-Pesa callback handler
 * ✅ Now uses UPDATE logic (database-first approach)
 */
router.post("/callback", async (req: Request, res: Response) => {
  try {
    console.log("=".repeat(60));
    console.log("📲 M-Pesa Callback Received at:", new Date().toISOString());
    console.log("📲 M-Pesa Callback Body:", JSON.stringify(req.body, null, 2));
    console.log("=".repeat(60));

    const { Body } = req.body;

    if (!Body || !Body.stkCallback) {
      return res.status(200).json({ ResultCode: 0, ResultDesc: "Success" });
    }

    const {
      MerchantRequestID,
      CheckoutRequestID,
      ResultCode,
      ResultDesc,
      CallbackMetadata,
    } = Body.stkCallback;

    // ✅ DATABASE-FIRST: Find existing transaction (should always exist now)
    const existingTransaction = await prisma.mpesaTransaction.findUnique({
      where: { checkoutRequestId: CheckoutRequestID },
    });

    if (!existingTransaction) {
      console.error(
        `❌ CRITICAL: Transaction not found in database: ${CheckoutRequestID}`
      );
      console.error("This should never happen with database-first approach!");
      return res.status(200).json({ ResultCode: 0, ResultDesc: "Success" });
    }

    console.log(
      `✅ Found existing transaction in DB: ${existingTransaction.id}`
    );

    // ✅ FIX: Convert ResultCode to number (Safaricom sends it as string sometimes)
    const resultCodeNum = Number(ResultCode);
    console.log(`📊 ResultCode: ${ResultCode} (type: ${typeof ResultCode}, parsed: ${resultCodeNum})`);

    // Determine final status based on result code
    let finalStatus: string;
    if (resultCodeNum === 0) {
      finalStatus = "SUCCESS";
    } else if (resultCodeNum === 1032) {
      finalStatus = "CANCELLED";
    } else {
      finalStatus = "FAILED";
    }

    // Extract metadata (only available on success)
    let mpesaReceiptNumber: string | null = null;
    let transactionDate: Date | null = null;
    let mpesaUserName: string | null = null;

    console.log(`📦 CallbackMetadata exists: ${!!CallbackMetadata}, Items: ${CallbackMetadata?.Item?.length || 0}`);

    if (resultCodeNum === 0 && CallbackMetadata?.Item) {
      const metadata = CallbackMetadata.Item;

      // Log all metadata items for debugging
      console.log(`📋 Callback Metadata Items:`);
      metadata.forEach((item: any) => {
        console.log(`   - ${item.Name}: ${item.Value}`);
      });

      mpesaReceiptNumber =
        metadata.find((item: any) => item.Name === "MpesaReceiptNumber")
          ?.Value || null;

      console.log(`🧾 Extracted mpesaReceiptNumber: ${mpesaReceiptNumber}`);

      // ✅ FIX: Parse Safaricom date format (YYYYMMDDHHmmss)
      const transactionDateValue = metadata.find(
        (item: any) => item.Name === "TransactionDate"
      )?.Value;

      if (transactionDateValue) {
        const dateStr = String(transactionDateValue);
        // Parse YYYYMMDDHHmmss format
        const year = dateStr.substring(0, 4);
        const month = dateStr.substring(4, 6);
        const day = dateStr.substring(6, 8);
        const hour = dateStr.substring(8, 10);
        const minute = dateStr.substring(10, 12);
        const second = dateStr.substring(12, 14);
        transactionDate = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}`);
        console.log(`📅 Parsed transactionDate: ${transactionDate.toISOString()}`);
      }

      // Extract name from callback if available
      const firstName = metadata.find(
        (item: any) => item.Name === "FirstName"
      )?.Value;
      const lastName = metadata.find((item: any) => item.Name === "LastName")
        ?.Value;

      if (firstName && lastName) {
        mpesaUserName = `${firstName} ${lastName}`.trim();
      } else if (firstName || lastName) {
        mpesaUserName = (firstName || lastName).trim();
      }
    }

    // ✅ UPDATE existing transaction with callback data
    console.log(`💾 Updating transaction with: mpesaReceiptNumber=${mpesaReceiptNumber}, status=${finalStatus}`);

    const updatedTransaction = await prisma.mpesaTransaction.update({
      where: { checkoutRequestId: CheckoutRequestID },
      data: {
        status: finalStatus,
        resultCode: resultCodeNum,
        resultDesc: ResultDesc,
        ...(mpesaReceiptNumber && { mpesaReceiptNumber }),
        ...(transactionDate && { transactionDate }),
        ...(mpesaUserName && { userName: mpesaUserName }),
        callbackReceivedAt: new Date(),
      },
    });

    console.log(`✅ Transaction updated - DB mpesaReceiptNumber: ${updatedTransaction.mpesaReceiptNumber}`);

    // Log appropriate message based on status
    if (finalStatus === "SUCCESS") {
      console.log(
        `✅ Payment Successful - Receipt: ${mpesaReceiptNumber}, Amount: KES ${updatedTransaction.amount}, User: ${
          updatedTransaction.userName || "N/A"
        }`
      );
    } else if (finalStatus === "CANCELLED") {
      console.log(
        `❌ Payment Cancelled - User: ${updatedTransaction.userId}, Amount: KES ${updatedTransaction.amount}`
      );
    } else {
      console.log(
        `❌ Payment Failed - User: ${updatedTransaction.userId}, Amount: KES ${updatedTransaction.amount}, Reason: ${ResultDesc}`
      );
    }

    console.log(`💾 Transaction ${updatedTransaction.id} updated in DB`);

    return res.status(200).json({ ResultCode: 0, ResultDesc: "Success" });
  } catch (error: any) {
    console.error("❌ M-Pesa Callback Error:", error);
    return res.status(200).json({ ResultCode: 0, ResultDesc: "Success" });
  }
});

/**
 * GET /api/mpesa/status/:checkoutRequestId
 * Check payment status by checkout request ID
 * ✅ Now uses database-first approach
 */
router.get(
  "/status/:checkoutRequestId",
  async (req: Request, res: Response) => {
    try {
      const { checkoutRequestId } = req.params;
      console.log(`🔍 Status check for: ${checkoutRequestId}`);

      // ✅ DATABASE-FIRST: Transaction should always exist
      const transaction = await prisma.mpesaTransaction.findUnique({
        where: { checkoutRequestId },
      });

      if (!transaction) {
        console.log(`❌ Transaction not found: ${checkoutRequestId}`);
        return res.status(404).json({
          success: false,
          status: "NOT_FOUND",
          message: "Transaction not found",
        });
      }

      console.log(`✅ Found transaction - Status: ${transaction.status}`);

      // Return current status
      if (transaction.status === "SUCCESS") {
        return res.status(200).json({
          success: true,
          status: "SUCCESS",
          data: {
            id: transaction.id,
            mpesaReceiptNumber: transaction.mpesaReceiptNumber,
            phoneNumber: transaction.phoneNumber,
            amount: transaction.amount,
            transactionDate: transaction.transactionDate,
            userId: transaction.userId,
            userName: transaction.userName,
            accountReference: transaction.accountReference,
          },
        });
      } else if (transaction.status === "PENDING") {
        // Check if we should query M-Pesa API directly (after 30 seconds)
        const timeSinceInitiation = transaction.initiatedAt
          ? Date.now() - transaction.initiatedAt.getTime()
          : 0;

        if (timeSinceInitiation > 30000) {
          console.log(`⏰ 30s elapsed, querying M-Pesa API directly...`);

          try {
            const queryResult = await mpesaService.stkQuery(checkoutRequestId);
            console.log(
              `📊 M-Pesa Query Result:`,
              JSON.stringify(queryResult, null, 2)
            );

            // Update transaction based on query result
            let finalStatus: string;
            if (queryResult.ResultCode === "0") {
              finalStatus = "SUCCESS";
            } else if (queryResult.ResultCode === "1032") {
              finalStatus = "CANCELLED";
            } else {
              finalStatus = "FAILED";
            }

            const updatedTransaction = await prisma.mpesaTransaction.update({
              where: { checkoutRequestId },
              data: {
                status: finalStatus,
                resultCode: parseInt(queryResult.ResultCode),
                resultDesc: queryResult.ResultDesc || null,
              },
            });

            console.log(
              `✅ Payment confirmed via query - Status: ${finalStatus}`
            );

            return res.status(200).json({
              success: finalStatus === "SUCCESS",
              status: finalStatus,
              message:
                finalStatus === "SUCCESS"
                  ? "Payment successful"
                  : finalStatus === "CANCELLED"
                  ? "Payment cancelled"
                  : queryResult.ResultDesc || "Payment failed",
              data:
                finalStatus === "SUCCESS"
                  ? {
                      id: updatedTransaction.id,
                      mpesaReceiptNumber: updatedTransaction.mpesaReceiptNumber,
                      phoneNumber: updatedTransaction.phoneNumber,
                      amount: updatedTransaction.amount,
                      transactionDate: updatedTransaction.transactionDate,
                      userId: updatedTransaction.userId,
                      userName: updatedTransaction.userName,
                      accountReference: updatedTransaction.accountReference,
                    }
                  : undefined,
            });
          } catch (queryError: any) {
            console.error(`❌ M-Pesa query failed:`, queryError.message);
          }
        }

        // Still waiting for user to complete payment
        console.log(`⏳ Still pending - waiting for callback`);
        return res.status(200).json({
          success: true,
          status: "PENDING",
          message: "Waiting for payment confirmation",
          data: {
            userId: transaction.userId,
            amount: transaction.amount,
            phoneNumber: transaction.phoneNumber,
            accountReference: transaction.accountReference,
            initiatedAt: transaction.initiatedAt,
          },
        });
      } else if (transaction.status === "CANCELLED") {
        return res.status(200).json({
          success: false,
          status: "CANCELLED",
          message: "Payment was cancelled by user",
        });
      } else if (transaction.status === "FAILED") {
        return res.status(200).json({
          success: false,
          status: "FAILED",
          message: transaction.resultDesc || "Payment failed",
          errorCode: transaction.resultCode,
        });
      }

      // Fallback
      return res.status(200).json({
        success: false,
        status: transaction.status,
        message: "Unknown status",
      });
    } catch (error: any) {
      console.error("❌ Status Check Error:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to check transaction status",
      });
    }
  }
);

/**
 * GET /api/mpesa/transactions/:userId
 * Get user's transaction history
 */
router.get("/transactions/:userId", async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
    const { limit = "20", offset = "0" } = req.query;

    const transactions = await prisma.mpesaTransaction.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: parseInt(limit as string),
      skip: parseInt(offset as string),
    });

    return res.status(200).json({
      success: true,
      data: transactions,
    });
  } catch (error: any) {
    console.error("❌ Transaction History Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch transactions",
    });
  }
});

/**
 * GET /api/mpesa/receipt/:checkoutRequestId
 * Get the latest receipt for a transaction (useful when callback arrives late)
 */
router.get("/receipt/:checkoutRequestId", async (req: Request, res: Response) => {
  try {
    const { checkoutRequestId } = req.params;

    const transaction = await prisma.mpesaTransaction.findUnique({
      where: { checkoutRequestId },
      select: {
        id: true,
        status: true,
        mpesaReceiptNumber: true,
        amount: true,
        transactionDate: true,
        callbackReceivedAt: true,
        updatedAt: true,
      },
    });

    if (!transaction) {
      return res.status(404).json({
        success: false,
        message: "Transaction not found",
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        ...transaction,
        hasReceipt: !!transaction.mpesaReceiptNumber,
        callbackReceived: !!transaction.callbackReceivedAt,
      },
    });
  } catch (error: any) {
    console.error("❌ Receipt Fetch Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch receipt",
    });
  }
});

/**
 * GET /api/mpesa/debug/pending-without-receipt
 * Debug endpoint: Find all SUCCESS transactions missing receipt (callback never arrived)
 */
router.get("/debug/pending-without-receipt", async (req: Request, res: Response) => {
  try {
    const transactions = await prisma.mpesaTransaction.findMany({
      where: {
        status: "SUCCESS",
        mpesaReceiptNumber: null,
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    return res.status(200).json({
      success: true,
      count: transactions.length,
      message: transactions.length > 0
        ? "These transactions succeeded but callback never arrived"
        : "All successful transactions have receipts",
      data: transactions.map((t) => ({
        id: t.id,
        checkoutRequestId: t.checkoutRequestId,
        amount: t.amount,
        status: t.status,
        createdAt: t.createdAt,
        callbackReceivedAt: t.callbackReceivedAt,
      })),
    });
  } catch (error: any) {
    console.error("❌ Debug Query Error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to query transactions",
    });
  }
});

export default router;
