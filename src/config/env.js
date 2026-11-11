import dotenv from 'dotenv';
import { z } from 'zod';

// Load environment variables from .env file
dotenv.config();

const envSchema = z.object({
  PORT: z.string().default('3000').transform(val => parseInt(val, 10)),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PRIMARY_MODEL: z.string().default('gemini-3.8-flash'), // WHY: Match valid Google AI Studio model ID
  BACKUP_MODEL: z.string().default('gemini-3.5-flash-lite'),  JINA_API_KEY:  z.string().min(1, 'JINA_API_KEY is required'),
  OPENROUTER_API_KEY: z.string().min(1, 'OPENAI_API_KEY is required'),
  GEMINI_API_KEY:  z.string().min(1, 'JINA_API_KEY is required')
});

const result = envSchema.safeParse(process.env);

if (!result.success) {
  console.error('❌ Invalid environment variables:', JSON.stringify(result.error.format(), null, 2));
  process.exit(1);
}

// Single clean export of validated environment variables
export const env = result.data;