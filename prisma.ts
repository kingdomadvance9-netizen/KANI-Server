import { PrismaClient } from "./generated/prisma";
import dotenv from "dotenv";

// 1. Ensure environment variables are loaded before anything else
dotenv.config();

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error("❌ DATABASE_URL is not defined in your .env file");
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

// 4. Initialize Prisma Client
export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

// Test connection
prisma
  .$connect()
  .then(() => console.log("🟢 Prisma Connected Successfully"))
  .catch((err) => console.error("🔴 Prisma Connection Error:", err.message));
