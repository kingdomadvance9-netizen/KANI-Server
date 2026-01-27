import { PrismaClient } from "./generated/prisma";
import dotenv from "dotenv";

// 1. Ensure environment variables are loaded before anything else
dotenv.config();

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error("❌ DATABASE_URL is not defined in your .env file");
  process.exit(1);
}

// ===== SINGLETON PATTERN FOR PRISMA =====
// Prevents multiple instances in development (hot-reload)
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

// ===== CONNECTION POOL CONFIGURATION =====
export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ["error", "warn"],
    datasources: {
      db: {
        url: connectionString,
      },
    },
    // ✅ Enable connection pooling with timeout protection
    // This is handled by the connection string, but we can set query timeout
  });

// ===== DEVELOPMENT HOT-RELOAD PROTECTION =====
if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

// ===== CONNECTION LIFECYCLE MANAGEMENT =====

// Initial connection test with retry
let connectionAttempts = 0;
const MAX_RETRIES = 3;

async function connectWithRetry() {
  try {
    await prisma.$connect();
    console.log("🟢 Prisma Connected Successfully");
    connectionAttempts = 0;
  } catch (err: any) {
    connectionAttempts++;
    console.error(
      `🔴 Prisma Connection Error (attempt ${connectionAttempts}/${MAX_RETRIES}):`,
      err.message
    );

    if (connectionAttempts < MAX_RETRIES) {
      console.log(`⏳ Retrying in 5 seconds...`);
      await new Promise((resolve) => setTimeout(resolve, 5000));
      return connectWithRetry();
    } else {
      console.error("❌ Failed to connect to database after multiple attempts");
      process.exit(1);
    }
  }
}

// Connect immediately
connectWithRetry();

// ===== KEEP-ALIVE HEARTBEAT =====
// Prevents idle connection closure by running a lightweight query every 4 minutes
// Neon's idle timeout is typically 5 minutes, so we ping before that
const HEARTBEAT_INTERVAL = 4 * 60 * 1000; // 4 minutes

async function databaseHeartbeat() {
  try {
    // Execute a lightweight query to keep connection alive
    await prisma.$queryRaw`SELECT 1`;
    console.log("💓 Database heartbeat - connection alive");
  } catch (err: any) {
    console.error("❌ Heartbeat failed, attempting reconnect:", err.message);
    // Try to reconnect
    try {
      await prisma.$disconnect();
      await connectWithRetry();
    } catch (reconnectErr: any) {
      console.error("❌ Reconnection failed:", reconnectErr.message);
    }
  }
}

// Start heartbeat after successful connection
let heartbeatInterval: NodeJS.Timeout | null = null;

export function startHeartbeat() {
  if (heartbeatInterval) {
    console.log("ℹ️ Heartbeat already running");
    return;
  }

  heartbeatInterval = setInterval(databaseHeartbeat, HEARTBEAT_INTERVAL);
  console.log(`💓 Database heartbeat started (every ${HEARTBEAT_INTERVAL / 1000}s)`);
}

export function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
    console.log("⏹️ Database heartbeat stopped");
  }
}

// ===== GRACEFUL SHUTDOWN =====
// Close connections when server stops
const gracefulShutdown = async () => {
  console.log("⏹️ Shutting down server gracefully...");
  stopHeartbeat();
  await prisma.$disconnect();
  console.log("✅ Prisma disconnected gracefully");
  process.exit(0);
};

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);
process.on("beforeExit", async () => {
  stopHeartbeat();
  await prisma.$disconnect();
});
