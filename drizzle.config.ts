/** @type { import("drizzle-kit").Config } */
export default {
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./migrations",
  driver: "d1-http",
  dbCredentials: {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID || "",
    databaseId: process.env.DATABASE_ID || "",
    token: process.env.DATABASE_TOKEN || "",
  },
};