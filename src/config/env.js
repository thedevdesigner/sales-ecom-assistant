import dotenv from 'dotenv';
import { z } from 'zod';

// Load environment variables from .env file via dotenv third-party package
dotenv.config();

const envSchema = z.object({
  PORT: z.string().default('3000').transform(val => parseInt(val, 10)),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PRIMARY_MODEL: z.string().min(1),
  BACKUP_MODEL: z.string().min(1),
  OPENROUTER_API_KEY: z.string().min(1)
});

const result = envSchema.safeParse(process.env);

if (!result.success) {
  console.error('❌ Invalid environment variables:', JSON.stringify(result.error.format(), null, 2));
  process.exit(1);
}

export const env = result.data;