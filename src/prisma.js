import { createRequire } from "module";
import { resolve } from "path";

if (!process.env.PRISMA_CLIENT_PATH) {
    throw new Error("PRISMA_CLIENT_PATH is not set in .env");
}

const require = createRequire(import.meta.url);
const { PrismaClient } = require(resolve(process.env.PRISMA_CLIENT_PATH));

export const prisma = new PrismaClient();