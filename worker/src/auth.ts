import { betterAuth } from "better-auth";
import { Env } from "./types";

export const createAuth = (env: Env) =>
  betterAuth({
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
      additionalFields: {
        role: {
          type: "string",
          defaultValue: "member",
        },
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
