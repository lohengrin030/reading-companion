import 'dotenv/config';

export const config = {
  port: process.env.PORT || 4000,
  host: process.env.HOST || '0.0.0.0',
  aiProvider: process.env.AI_PROVIDER || 'deepseek',
  isProd: process.env.NODE_ENV === 'production',
};
