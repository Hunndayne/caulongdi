import { betterAuth } from "better-auth";
import { Env } from "./types";

export const createAuth = (env: Env) =>
  betterAuth({
    baseURL: env.FRONTEND_URL,
    database: {
      dialect: {
        async exec(query: string) {
          const result = await env.DB.exec(query);
          return { rows: [] };
        },
        async query(query: string, params?: unknown[]) {
          const stmt = env.DB.prepare(query);
          const bound = params?.length ? stmt.bind(...params) : stmt;
          const result = await bound.all();
          return { rows: result.results as Record<string, unknown>[] };
        },
        async run(query: string, params?: unknown[]) {
          const stmt = env.DB.prepare(query);
          const bound = params?.length ? stmt.bind(...params) : stmt;
          await bound.run();
        },
      },
      type: "sqlite",
    },
    secret: env.BETTER_AUTH_SECRET,
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
      },
    },
    trustedOrigins: [env.FRONTEND_URL],
    user: {
      modelName: "users",
      fields: {
        emailVerified: "email_verified",
        image: "avatar_url",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
      additionalFields: {
        role: {
          type: "string",
          defaultValue: "member",
        },
      },
    },
    session: {
      modelName: "sessions_auth",
      fields: {
        expiresAt: "expires_at",
        token: "token",
        createdAt: "created_at",
        updatedAt: "updated_at",
        ipAddress: "ip_address",
        userAgent: "user_agent",
        userId: "user_id",
      },
    },
    account: {
      modelName: "accounts",
      fields: {
        accountId: "account_id",
        providerId: "provider_id",
        userId: "user_id",
        accessToken: "access_token",
        refreshToken: "refresh_token",
        idToken: "id_token",
        accessTokenExpiresAt: "access_token_expires_at",
        refreshTokenExpiresAt: "refresh_token_expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
    },
    verification: {
      modelName: "verifications",
      fields: {
        expiresAt: "expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
    },
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            const count = await env.DB.prepare("SELECT COUNT(*) as cnt FROM users")
              .first<{ cnt: number }>();
            if (count && count.cnt === 1) {
              await env.DB.prepare("UPDATE users SET role = 'admin' WHERE id = ?")
                .bind(user.id)
                .run();
            }
          },
        },
      },
    },
  });
