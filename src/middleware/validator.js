import { z } from 'zod';

export const chatBodySchema = z.object({
  vendorId: z.string().min(1, 'Vendor ID is required'),
  sessionId: z.string().min(1, 'Session ID is required'),
  messages: z.array(
    z.object({
      role: z.enum(['user', 'assistant', 'system']),
      content: z.string().max(2000, 'Message content too long').min(1, 'Message content cannot be empty')
    })
  ).min(1, 'At least one message is required').max(15, 'Too many messages provided'),
  pageUrl: z.string().url('Invalid page URL'),
  strikes: z.number().int().nonnegative().default(0)
});

export function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        error: {
          code: 400,
          message: 'Invalid request body',
          details: result.error.format()
        }
      });
    }
    req.validatedBody = result.data;
    next();
  };
}