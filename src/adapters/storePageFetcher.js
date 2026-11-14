import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

/**
 * ============================================================================
 * EXPORTABLE MODULE: JINA AI STORE PAGE FETCHER
 * ============================================================================
 * 
 * Requirements & Dependencies:
 * - Requires `env.JINA_API_KEY` set in your environment variables.
 * - Requires `env` configuration object and `logger` utility.
 * - Uses Jina Reader API (https://r.jina.ai/) with Bearer token authentication
 *   to bypass Cloudflare firewalls and obtain clean Markdown.
 */
// [CAN BE EXPORTED]
export async function fetchStorePageContent(storeOrigin, topic) {
  if (!storeOrigin) return "Store URL unavailable.";

  const pathMap = {
    contact: ['/pages/contact-us', '/pages/contact', '/'],
    refund_policy: ['/policies/refund-policy', '/pages/refund-policy', '/pages/returns'],
    shipping_policy: ['/policies/shipping-policy', '/pages/shipping-policy', '/pages/shipping'],
    terms_of_service: ['/policies/terms-of-service', '/pages/terms-of-service', '/pages/terms'],
    privacy_policy: ['/policies/privacy-policy', '/pages/privacy-policy', '/pages/privacy'],
    about: ['/pages/about-us', '/pages/about', '/'],
    general: ['/']
  };

  const candidates = pathMap[topic] || ['/'];
  const jinaApiKey = env.JINA_API_KEY;

  for (const path of candidates) {
    try {
      const targetUrl = `${storeOrigin}${path}`;
      const jinaEndpoint = `https://r.jina.ai/${targetUrl}`;

      const headers = {
        'Accept': 'text/plain',
        'X-With-Generated-Alt': 'true'
      };

      if (jinaApiKey) {
        headers['Authorization'] = `Bearer ${jinaApiKey}`;
      } else {
        logger.warn('[Jina Fetch] JINA_API_KEY is missing. Unauthenticated requests may trigger rate limits.');
      }

      const response = await fetch(jinaEndpoint, {
        headers,
        signal: AbortSignal.timeout(12000)
      });

      if (!response.ok) continue;

      const markdownContent = await response.text();
      
      if (markdownContent && markdownContent.length > 150) {
        return markdownContent.slice(0, 10000); // Token budget safe truncation
      }
    } catch (err) {
      logger.warn('[Jina Fetch] Candidate failed', { path, error: err.message });
    }
  }

  return "No specific policy or contact page text could be retrieved from the storefront via Jina Reader.";
}