import express from 'express';
import helmet from 'helmet';
import { env } from './src/config/env.js';
import { loadVendors } from './src/loaders/vendorLoader.js';
import configRouter from './src/routes/config.js';
import chatRouter from './src/routes/chat.js';
import cors from 'cors'

const app = express();
app.set('trust proxy', 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Accept', 'skip_zrok_interstitial']
}));
app.options('*', cors());
app.use(express.json({ limit: '10kb', type: ['application/json', 'text/plain'] }));

loadVendors();

app.get('/health', (req, res) => {
  res.status(200).json({ ok: true, time: new Date().toISOString() });
});

app.use('/config', configRouter);
app.use('/chat', chatRouter);
app.use((req, res) => res.status(404).json({ error: 'not_found' }));
app.use((err, req, res, next) => {
  console.error('request error:', err);
  res.status(err.status || 500).json({ error: 'server_error' });
});
app.listen(env.PORT, () => {
  console.log(`Server running on port ${env.PORT} in ${env.NODE_ENV} mode`);
});