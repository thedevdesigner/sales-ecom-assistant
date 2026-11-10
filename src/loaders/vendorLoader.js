import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const vendorSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  platform: z.enum(['shopify', 'woocommerce', 'auto']),
  storeUrl: z.string().url(),
  allowedOrigins: z.array(z.string()),
  currency: z.string().min(1),
  widgetConfig: z.object({
    title: z.string(),
    primaryColor: z.string(),
    welcomeMessage: z.string()
  }),
  limits: z.object({
    messagesPerVisitorPerHour: z.number().int().positive(),
    monthlyAiCallCap: z.number().int().positive()
  })
});

const vendorsListSchema = z.array(vendorSchema);
let vendorsCache = new Map();

export function loadVendors() {
  const filePath = path.resolve(process.cwd(), 'data/vendors.json');
  const rawData = fs.readFileSync(filePath, 'utf8');
  const parsedJson = JSON.parse(rawData);
  
  const validationResult = vendorsListSchema.safeParse(parsedJson);
  if (!validationResult.success) {
    throw new Error(`Invalid vendors.json schema: ${JSON.stringify(validationResult.error.format())}`);
  }

  vendorsCache.clear();
  for (const vendor of validationResult.data) {
    vendorsCache.set(vendor.id, vendor);
  }
  return vendorsCache;
}

export function getVendor(vendorId) {
  return vendorsCache.get(vendorId);
}

loadVendors();