export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  AI: Ai;
  FRONTEND_URL: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  BETTER_AUTH_SECRET: string;
  PAYMENT_WEBHOOK_SECRET?: string;
  PAYMENT_AUTOCONFIRM_EMAIL?: string;
  SMTP_SERVER: string;
  SMTP_PORT: string;
  SMTP_LOGIN: string;
  SMTP_PASSWORD: string;
  SMTP_FROM_EMAIL?: string;
  SMTP_FROM_NAME?: string;
  AI_DAILY_NEURON_BUDGET?: string;
  AI_RECEIPT_SCAN_RESERVED_NEURONS?: string;
  BOT_SERVICE_SECRET?: string;
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_MODEL?: string;
  DEEPSEEK_BASE_URL?: string;
}

export type AppRole = 'admin' | 'member';

declare module 'hono' {
  interface ContextVariableMap {
    userId: string;
    userRole: AppRole;
  }
}
