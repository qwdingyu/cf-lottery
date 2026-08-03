import { Hono } from "hono";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";

const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("emailVerified", { mode: "boolean" }).notNull(),
  image: text("image"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
});

const session = sqliteTable("session", {
  id: text("id").primaryKey(),
  expiresAt: integer("expiresAt", { mode: "timestamp" }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
  ipAddress: text("ipAddress"),
  userAgent: text("userAgent"),
  userId: text("userId").notNull().references(() => user.id, { onDelete: "cascade" }),
});

const account = sqliteTable("account", {
  id: text("id").primaryKey(),
  accountId: text("accountId").notNull(),
  providerId: text("providerId").notNull(),
  userId: text("userId").notNull().references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("accessToken"),
  refreshToken: text("refreshToken"),
  idToken: text("idToken"),
  accessTokenExpiresAt: integer("accessTokenExpiresAt", { mode: "timestamp" }),
  refreshTokenExpiresAt: integer("refreshTokenExpiresAt", { mode: "timestamp" }),
  scope: text("scope"),
  password: text("password"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
});

const verification = sqliteTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expiresAt", { mode: "timestamp" }).notNull(),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
});

const authSchema = { user, session, account, verification };
const baseURL = "http://localhost:3000/api/auth";

const clients: Client[] = [];
const dbPaths: string[] = [];

export async function cleanupBetterAuthSmokeDbs() {
  await Promise.all(clients.map((client) => client.close()));
  clients.length = 0;
  for (const path of dbPaths.splice(0)) {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      try {
        unlinkSync(`${path}${suffix}`);
      } catch {
        /* ignore */
      }
    }
  }
}

export async function createBetterAuthSmokeApp() {
  const dbPath = join(tmpdir(), `cf-lottery-better-auth-smoke-${crypto.randomUUID()}.db`);
  dbPaths.push(dbPath);
  const client = createClient({ url: `file:${dbPath}` });
  clients.push(client);
  await createBetterAuthTables(client);

  const db = drizzle(client, { schema: authSchema });
  const auth = betterAuth({
    baseURL,
    secret: "better-auth-smoke-secret-at-least-32-chars",
    trustedOrigins: ["http://localhost:3000"],
    database: drizzleAdapter(db, {
      provider: "sqlite",
      schema: authSchema,
      camelCase: true,
    }),
    emailAndPassword: {
      enabled: true,
    },
    socialProviders: {
      google: {
        clientId: "google-client-id-for-smoke-test",
        clientSecret: "google-client-secret-for-smoke-test",
      },
    },
  });

  const app = new Hono();
  app.on(["GET", "POST"], "/api/auth/**", (c) => auth.handler(c.req.raw));
  return { app, client };
}

async function createBetterAuthTables(client: Client) {
  await client.batch([
    `CREATE TABLE "user" (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      emailVerified INTEGER NOT NULL,
      image TEXT,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    )`,
    `CREATE TABLE "session" (
      id TEXT PRIMARY KEY NOT NULL,
      expiresAt INTEGER NOT NULL,
      token TEXT NOT NULL UNIQUE,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      ipAddress TEXT,
      userAgent TEXT,
      userId TEXT NOT NULL,
      FOREIGN KEY (userId) REFERENCES "user"(id) ON DELETE CASCADE
    )`,
    `CREATE INDEX session_userId_idx ON "session" (userId)`,
    `CREATE TABLE "account" (
      id TEXT PRIMARY KEY NOT NULL,
      accountId TEXT NOT NULL,
      providerId TEXT NOT NULL,
      userId TEXT NOT NULL,
      accessToken TEXT,
      refreshToken TEXT,
      idToken TEXT,
      accessTokenExpiresAt INTEGER,
      refreshTokenExpiresAt INTEGER,
      scope TEXT,
      password TEXT,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      FOREIGN KEY (userId) REFERENCES "user"(id) ON DELETE CASCADE
    )`,
    `CREATE INDEX account_userId_idx ON "account" (userId)`,
    `CREATE TABLE "verification" (
      id TEXT PRIMARY KEY NOT NULL,
      identifier TEXT NOT NULL,
      value TEXT NOT NULL,
      expiresAt INTEGER NOT NULL,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    )`,
    `CREATE INDEX verification_identifier_idx ON "verification" (identifier)`,
  ]);
}
