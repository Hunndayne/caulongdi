import { betterAuth } from "better-auth";
import { isAdminEmail } from "./admin";
import { Env } from "./types";

export const createAuth = (env: Env, request?: Request) => {
  const origin = (
    request ? new URL(request.url).origin : env.FRONTEND_URL ?? ""
  ).trim();

  return betterAuth({
    baseURL: origin,
    basePath: "/api/auth",
    database: env.DB,
    secret: env.BETTER_AUTH_SECRET,
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
      },
    },
    trustedOrigins: origin ? [origin] : [],
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
            if (isAdminEmail(user.email) || (count && count.cnt === 1)) {
              await env.DB.prepare("UPDATE users SET role = 'admin' WHERE id = ?")
                .bind(user.id)
                .run();
            }

            await env.DB.prepare(`
              INSERT OR IGNORE INTO group_members (group_id, user_id, role, created_at)
              SELECT 'default', ?, 'member', ?
              WHERE EXISTS (SELECT 1 FROM groups WHERE id = 'default')
            `)
              .bind(user.id, new Date().toISOString())
              .run()
              .catch(() => {});
          },
        },
      },
    },
  });
};
