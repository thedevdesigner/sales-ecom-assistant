export const logger = {
  info(message, meta = {}) {
    console.log(JSON.stringify({ level: 'info', timestamp: new Date().toISOString(), message, ...meta }));
  },
  warn(message, meta = {}) {
    console.warn(JSON.stringify({ level: 'warn', timestamp: new Date().toISOString(), message, ...meta }));
  },
  error(message, meta = {}) {
    console.error(JSON.stringify({ level: 'error', timestamp: new Date().toISOString(), message, ...meta }));
  }
};