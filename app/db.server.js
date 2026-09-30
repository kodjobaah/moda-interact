import { PrismaClient } from "@prisma/client";

/** @type {typeof globalThis & { prismaGlobal?: PrismaClient }} */
const globalForPrisma = globalThis;

if (process.env.NODE_ENV !== "production") {
  if (!globalForPrisma.prismaGlobal) {
    globalForPrisma.prismaGlobal = new PrismaClient();
  }
}

const prisma = globalForPrisma.prismaGlobal ?? new PrismaClient();

export default prisma;
