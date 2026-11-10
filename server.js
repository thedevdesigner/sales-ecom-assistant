import express from 'express';
import helmet from 'helmet';
import { env } from './src/config/env.js';
import { loadVendors } from './src/loaders/vendorLoader.js';

const app = express();
app.use(helmet());
app.use(express.json({ limit: '10kb' }));

loadVendors();

app.get('/health', (req, res) => {
  res.status(200).json({ ok: true, time: new Date().toISOString() });
});

app.listen(env.PORT, () => {
  console.log(`Server running on port ${env.PORT} in ${env.NODE_ENV} mode`);
});