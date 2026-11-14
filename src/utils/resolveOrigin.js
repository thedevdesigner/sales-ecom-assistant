export function resolveStoreOrigin(req) {
  const { storeUrl, pageUrl } = req.body || {};
  for (const candidate of [storeUrl, pageUrl, req.headers.origin, req.headers.referer]) {
    if (candidate && /^https?:\/\//i.test(candidate)) {
      try {
        return new URL(candidate).origin;
      } catch {}
    }
  }
  return null;
}