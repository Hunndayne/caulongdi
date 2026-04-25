import { betterAuth } from "better-auth";
import { Env } from "./types";

export const createAuth = (env: Env, request?: Request) => {
  const baseURL = (
    request ? new URL(request.url).origin : env.FRONTEND_URL ?? ""
  ).trim();

  return betterAuth({
    baseURL,
    database: env.DB,
    secret: env.BETTER_AUTH_SECRET,
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
      },
    },
    trustedOrigins: baseURL ? [baseURL] : [],
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
};
