export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  FRONTEND_URL: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  BETTER_AUTH_SECRET: string;
  SMTP_SERVER: string;
  SMTP_PORT: string;
  SMTP_LOGIN: string;
  SMTP_PASSWORD: string;
  SMTP_FROM_EMAIL?: string;
  SMTP_FROM_NAME?: string;
}

export type AppRole = 'admin' | 'member';

declare module 'hono' {
  interface ContextVariableMap {
    userId: string;
    userRole: AppRole;
  }
}
