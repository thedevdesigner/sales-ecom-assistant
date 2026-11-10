import { env } from '../config/env.js';

export async function scrapeProductDetails(productUrl) {
  try {
    // Clean target URL and prepend Jina Reader
    const targetUrl = productUrl.startsWith('http') ? productUrl : `https://${productUrl}`;
    const jinaEndpoint = `https://r.jina.ai/${targetUrl}`;

    const response = await fetch(jinaEndpoint, {
      method: 'GET',
      headers: {
        'Accept': 'application/json', // Requests clean JSON structure containing title and markdown content
        // 'Authorization': `Bearer ${env.JINA_API_KEY}` // Optional: uncomment if you add a Jina key to env.js
      }
    });

    if (!response.ok) {
      throw new Error(`Jina Reader failed with status: ${response.status}`);
    }

    const data = await response.json();
    
    // Jina returns a data object with title, url, and content (Markdown)
    return {
      title: data.data?.title || 'Product Page',
      url: data.data?.url || targetUrl,
      content: data.data?.content?.slice(0, 4000) // Clean Markdown text ready for LLM consumption
    };
  } catch (err) {
    console.error(`[Jina Scraper Error] Failed to scrape ${productUrl}:`, err.message);
    return { error: `Could not retrieve details for this product page.` };
  }
}