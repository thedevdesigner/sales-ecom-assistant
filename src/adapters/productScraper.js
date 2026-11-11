import { convert } from '@vakra-dev/supermarkdown';
import { logger } from '../utils/logger.js';
import {env} from '../config/env.js'

export async function scrapeProductDetails(productUrl) {
  const targetUrl = productUrl.startsWith('http') ? productUrl : `https://${productUrl}`;
  console.log("🚨 [TOOL EXECUTED] Processing page content for:", targetUrl);

  // ---------------------------------------------------------------------------
  // STEP 1: Direct Fetch + Local Parsing via @vakra-dev/supermarkdown
  // ---------------------------------------------------------------------------
  try {
    const response = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });

    // If site blocks or fails (403, 429, 5xx, etc.), throw to trigger Jina fallback
    if (!response.ok) {
      throw new Error(`Direct fetch blocked/failed with HTTP status ${response.status}`);
    }

    const htmlContent = await response.text();

    // Convert HTML to clean markdown using Supermarkdown
    const cleanedMarkdown = convert(htmlContent, {
      excludeSelectors: ['nav', 'header', 'footer', 'script', 'style', '.cookie-banner', '.cart-drawer', '#shopify-section-header'],
      includeSelectors: ['main', '.product-section', '.shopify-policy__body', '.main-content', 'article', '.content']
    });

    const titleMatch = htmlContent.match(/<title[^>]*>([^<]+)<\/title>/i);
    const pageTitle = titleMatch ? titleMatch[1].trim() : 'Store Page';

    if (cleanedMarkdown && cleanedMarkdown.trim().length > 50) {
      console.log("⚡ [Scraper] Successfully parsed locally with @vakra-dev/supermarkdown");
      return {
        title: pageTitle,
        url: targetUrl,
        content: cleanedMarkdown.slice(0, 4000)
      };
    }

    // If Supermarkdown output was too short (empty DOM/JS rendering issue), fallback to Jina
    throw new Error("Direct parse returned insufficient body content (likely JS-rendered page)");

  } catch (directErr) {
    logger.warn(`[Scraper Warning] Direct fetch failed for ${targetUrl} (${directErr.message}). Initiating Jina AI fallback...`);

    // ---------------------------------------------------------------------------
    // STEP 2: FALLBACK — Jina AI Reader API (Bypasses blocks & renders JS)
    // ---------------------------------------------------------------------------
    try {
      const jinaEndpoint = `https://r.jina.ai/${targetUrl}`;
      const jinaResponse = await fetch(jinaEndpoint, {
        method: 'GET',
        headers: {
        'Accept': 'application/json', // Requests clean JSON structure containing title and markdown content
        'Authorization': `Bearer ${env.JINA_API_KEY}` // Optional: uncomment if you add a Jina key to env.js
      }
      });

      if (!jinaResponse.ok) {
        throw new Error(`Jina Reader failed with status: ${jinaResponse.status}`);
      }

      const jinaData = await jinaResponse.json();
      const rawJinaContent = jinaData.data?.content || '';

      // Pass Jina's raw content back through Supermarkdown for extra token cleanup
      const refinedContent = convert(rawJinaContent);

      console.log("🛡️ [Scraper] Successfully bypassed block using Jina AI Reader");
      return {
        title: jinaData.data?.title || 'Store Page',
        url: jinaData.data?.url || targetUrl,
        content: (refinedContent || rawJinaContent).slice(0, 4000)
      };

    } catch (jinaErr) {
      logger.error(`[Scraper Error] Both Direct and Jina fallbacks failed for ${targetUrl}:`, { error: jinaErr.message });
      return { error: `Could not retrieve details for this store page.` };
    }
  }
}