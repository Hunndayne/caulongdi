export interface Env {
  DB: D1Database;
  FRONTEND_URL: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  BETTER_AUTH_SECRET: string;
}

export type AppRole = 'admin' | 'member';

declare module 'hono' {
  interface ContextVariableMap {
    userId: string;
    userRole: AppRole;
  }
}
