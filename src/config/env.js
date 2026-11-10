import dotenv from 'dotenv';
import { z } from 'zod';

// Load environment variables from .env file
dotenv.config();

const envSchema = z.object({
  PORT: z.string().default('3000').transform(val => parseInt(val, 10)),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PRIMARY_MODEL: z.string().default('north-mini-code:free'),
  BACKUP_MODEL: z.string().default('recursive/flint-v1.0:free'),
OPENROUTER_API_KEY: z.string().min(1, 'OPENAI_API_KEY is required')
});

const result = envSchema.safeParse(process.env);

if (!result.success) {
  console.error('❌ Invalid environment variables:', JSON.stringify(result.error.format(), null, 2));
  process.exit(1);
}

// Single clean export of validated environment variables
export const env = result.data;