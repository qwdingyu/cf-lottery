/** @type { import("drizzle-kit").Config } */
export default {
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./migrations",
  driver: "turso",
  dbCredentials: {
    url: process.env.TURSO_URL || "",
    authToken: process.env.TURSO_TOKEN || "",
  },
};