import { generateAICompletion, generateAICompletionStream } from '../services/aiClient.js';
import { searchShopifyProducts, discoverStorePages } from '../adapters/shopifyAdapter.js';
import { scrapeProductDetails } from '../adapters/productScraper.js';
import { logger } from '../utils/logger.js';

// logger.warn may not exist in your logger: calling it threw a TypeError that escaped the pipeline and left the stream open forever
const warn = (...a) => (typeof logger.warn === 'function' ? logger.warn(...a) : logger.error(...a));
const DEADLINE_MS = Number(process.env.CHAT_DEADLINE_MS) || 25000;   // the request can never stay pending longer than this

/**
 * Strict timeout wrapper for external store/scraper operations.
 * Fails fast to prevent socket hanging and streaming stalls.
 */
async function withAdapterTimeout(promise, ms = 8000, fallback = null) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const agentTools = [
  {
    type: "function",
    function: {
      name: "search_products",
      description: "Search store catalog for specific product names or keywords. Never call for bestsellers or general catalogs.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Specific product keyword. Never pass empty or generic terms." },
          maxPrice: { type: "number", description: "Maximum budget limit." },
          minPrice: { type: "number", description: "Minimum budget limit." },
          limit: { type: "number", description: "Number of items to fetch (max 8)." }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "discover_store_pages",
      description: "Discover official store pages (policies, refund, return, shipping, terms, contact).",
      parameters: {
        type: "object",
        properties: {
          keyword: { type: "string", description: "Keyword to search ('refund', 'shipping', 'contact')" }
        },
        required: ["keyword"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "scrape_product_details",
      description: "Scrape and read page content or policy text via URL.",
      parameters: {
        type: "object",
        properties: {
          productUrl: { type: "string", description: "The full URL of the page to inspect." }
        },
        required: ["productUrl"]
      }
    }
  }
];

async function runInner(vendor, rawMessages, sink = null) {
  const messages = rawMessages.map((m) => ({ ...m }));   // never mutate the caller's array
  const storeUrl = vendor.storeUrl || `https://${vendor.domain || 'nordicknives.com'}`;
  const storeName = vendor.name || 'this store';
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')?.content || '';
  const normalizedUserQuery = lastUserMsg.toLowerCase().trim();

  let productsToDeliver = [];
  let chips = [];
  let intent = 'inquiry';
  let contextInjected = false;

  const updateStatus = (text) => {
    if (sink && typeof sink.status === 'function') sink.status(text);
  };

  // ---------------------------------------------------------------------------
  // 1. FAST-PATH POLICY PRE-ROUTER (Wrapped with Timeout)
  // ---------------------------------------------------------------------------
  const policyRegex = /\b(refunds?|returns?|polic(?:y|ies)|shipping|delivery|terms|privacy|contact|faq)\b/i;
  
  if (policyRegex.test(normalizedUserQuery)) {
    let kw = 'policy';
    if (/refund|return/.test(normalizedUserQuery)) kw = 'refund';
    else if (/shipping|deliver/.test(normalizedUserQuery)) kw = 'shipping';
    else if (/contact|support|reach/.test(normalizedUserQuery)) kw = 'contact';

    try {
      updateStatus('Checking store policies...');
      // 6-second max timeout for page discovery
      const discoveredPages = await withAdapterTimeout(discoverStorePages(storeUrl, kw), 6000, []);
      
      if (discoveredPages && discoveredPages.length > 0) {
        updateStatus('Reading official policy page...');
        // 6-second max timeout for policy scraping
        const scraped = await withAdapterTimeout(scrapeProductDetails(discoveredPages[0]), 6000, null);
        
        if (scraped && scraped.content && !scraped.error) {
          messages.push({
            role: "system",
            content: `[VERIFIED STORE POLICY FROM ${discoveredPages[0]}]:\n${scraped.content}\nAnswer strictly based on this context. Keep products [] empty.`
          });
          contextInjected = true;
          intent = 'inquiry';
        }
      }
    } catch (e) {
      warn('[Pre-Router] Policy check skipped due to timeout/error', { error: e.message });
    }
  }

  const systemMessage = {
    role: "system",
    content: `You are an expert, helpful AI shopping assistant for ${storeName}. 

Follow these core rules strictly:
1. **GREETINGS & GENERAL INQUIRIES**: Respond warmly and directly. Do NOT call any tools.
2. **BEST-SELLER REQUESTS**: Politely inform the user that best-selling rankings aren't listed, and ask for a specific category. Do NOT call "search_products".
3. **PURCHASE & PRODUCT SEARCH**: Call "search_products" with a clear keyword.
4. **INQUIRY**: Use verified policy context or discover/scrape store pages.
5. **OFF-TOPIC**: Decline politely in 1 sentence and pivot back to shopping.
- Never output raw JSON, code blocks, or markdown code formatting in your reply text.`
  };

  const conversationHistory = [systemMessage, ...messages.slice(-6)];
  let updatedHistory = [...conversationHistory];

  try {
    updateStatus('Analyzing request...');
    
    let initialResponse = await withAdapterTimeout(generateAICompletion(conversationHistory, contextInjected ? {} : {
      tools: agentTools,
      tool_choice: "auto"
    }), 12000, null);
    if (initialResponse === null) throw new Error('AI call timed out');

    let usedTools = false;

    // Single-turn tool execution guard
    if (initialResponse?.tool_calls && initialResponse.tool_calls.length > 0) {
      usedTools = true;
      updatedHistory.push(initialResponse);

      for (const toolCall of initialResponse.tool_calls) {
        const funcName = toolCall.function.name;
        let args = {};
        try { args = JSON.parse(toolCall.function.arguments || '{}'); } catch(e){}

        let toolResult = { status: 'EMPTY_RESULTS', products: [] };

        try {
          if (funcName === "search_products") {
            intent = 'purchase';
            let cleanQuery = (args.query || '').trim();
            
            const broadQueryRegex = /^(all|catalog|store|products|items|latest|collection|browse|bestseller|best seller|popular|sale|new)$/i;
            if (!cleanQuery || broadQueryRegex.test(cleanQuery)) {
              toolResult = {
                status: 'UNAVAILABLE_METRIC',
                message: 'Catalog rankings are not listed. Ask the user for a specific product keyword.'
              };
              chips = ['Browse categories', 'Contact support'];
            } else {
              updateStatus('Searching catalog...');
              console.time('⏱️ Vector Search / Product Lookup');
              
              // 🔑 8-SECOND TIMEOUT GUARD ON SHOPIFY CATALOG SEARCH
              const searchResults = await withAdapterTimeout(
                searchShopifyProducts(storeUrl, { query: cleanQuery, maxPrice: args.maxPrice, minPrice: args.minPrice, inStockOnly: true, limit: args.limit || 6 }, vendor.currency || 'USD'),
                8000,
                []
              );
              console.timeEnd('⏱️ Vector Search / Product Lookup');

              productsToDeliver = Array.isArray(searchResults) ? searchResults.slice(0, 6) : [];
              toolResult = {
                status: productsToDeliver.length > 0 ? 'FOUND' : 'EMPTY_RESULTS',
                products: productsToDeliver
              };

              if (productsToDeliver.length === 0) {
                chips = ["Try another keyword", "Contact support"];
              }
            }
          } 
          else if (funcName === "discover_store_pages") {
            intent = 'inquiry';
            // 6-second timeout guard
            const discoveredPages = await withAdapterTimeout(discoverStorePages(storeUrl, args.keyword || ''), 6000, []);
            toolResult = { status: discoveredPages.length > 0 ? 'FOUND' : 'EMPTY_RESULTS', pages: discoveredPages };
          }
          else if (funcName === "scrape_product_details") {
            intent = 'inquiry';
            // 8-second timeout guard
            const scrapedData = await withAdapterTimeout(scrapeProductDetails(args.productUrl), 8000, { error: 'Timeout' });
            toolResult = { status: scrapedData && !scrapedData.error ? 'FOUND' : 'EMPTY_RESULTS', details: scrapedData };
          }
        } catch (toolErr) {
          logger.error(`[Pipeline] Tool execution error '${funcName}'`, { error: toolErr.message });
        }

        updatedHistory.push({
          role: "tool",
          tool_call_id: toolCall.id,
          name: funcName,
          content: JSON.stringify(toolResult)
        });
      }
    }

    // Emit metadata frame once products and chips are resolved
    if (sink) {
      sink.meta({ intent, products: productsToDeliver, chips, state: 'normal', strikes: 0 });
    }

    updateStatus('Streaming response...');
    let finalReplyText = '';
    
    // Fast path for non-tool queries (greetings, policies) to avoid duplicate roundtrips
    if (!usedTools && typeof initialResponse === 'string' && initialResponse.trim()) {
      finalReplyText = initialResponse;
      if (sink) sink.delta(finalReplyText);
    } else if (sink && typeof generateAICompletionStream === 'function') {
      console.time('⏱️ LLM Token Generation / Response');
      finalReplyText = await generateAICompletionStream(updatedHistory, {
        onDelta: (text) => sink.delta(text),
        isAborted: () => sink.aborted
      });
      console.timeEnd('⏱️ LLM Token Generation / Response');
    } else {
      const finalMsg = typeof initialResponse === 'string' ? initialResponse : await generateAICompletion(updatedHistory);
      finalReplyText = typeof finalMsg === 'string' ? finalMsg : finalMsg?.content || '';
      if (sink) sink.delta(finalReplyText);
    }

    if (!finalReplyText || !finalReplyText.trim()) {
      finalReplyText = productsToDeliver.length > 0
        ? `Here are the items I found for you at ${storeName}:`
        : `Hi there! I'm your shopping assistant for ${storeName}. What product, category, or store question can I help you with today?`;
      if (sink) sink.delta(finalReplyText);
    }

    if (sink) sink.done({ state: 'normal', strikes: 0 });

    return {
      reply: finalReplyText,
      intent,
      products: productsToDeliver,
      state: 'normal',
      strikes: 0,
      ...(chips.length > 0 ? { chips } : {})
    };

  } catch (criticalErr) {
    logger.error('[Pipeline Critical Failure]', { error: criticalErr.message });
    const fallbackMessage = "I'm having a little trouble connecting right now. Please try again in a moment!";
    if (sink) {
      sink.meta({ intent: 'inquiry', products: [], chips: ["Try again"], state: 'normal', strikes: 0 });
      sink.delta(fallbackMessage);
      sink.done({ state: 'normal', strikes: 0 });
    }
    return { reply: fallbackMessage, intent: 'inquiry', products: [], state: 'normal', strikes: 0 };
  }
}

/**
 * Public entry point. Guarantees the stream is ALWAYS finished:
 *  - any exception, including ones thrown before the main try block, is caught
 *  - a hard deadline (25 s) ends the turn with a friendly message instead of leaving the request pending
 *  - late writes from slow background work are ignored once the turn is closed
 */
export async function runChatPipeline(vendor, rawMessages, sink = null) {
  let closed = false, metaSent = false;
  const guard = sink && {
    get aborted() { return sink.aborted; },
    status: (t) => { if (!closed) sink.status?.(t); },
    meta: (d) => { if (!closed) { metaSent = true; sink.meta(d); } },
    delta: (t) => { if (!closed) sink.delta(t); },
    done: (d) => { if (!closed) { closed = true; sink.done(d); } },
  };
  const FALLBACK = "Sorry, that is taking longer than expected. Please try again in a moment.";
  const finish = (reason) => {
    logger.error('[Pipeline] ended early', { reason });
    if (guard && !closed) {
      if (!metaSent) guard.meta({ intent: 'inquiry', products: [], chips: ['Try again'], state: 'normal', strikes: 0 });
      guard.delta(FALLBACK);
      guard.done({ state: 'normal', strikes: 0 });
    }
    closed = true;
    return { reply: FALLBACK, intent: 'inquiry', products: [], state: 'normal', strikes: 0, aiCalls: 1 };
  };

  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve('deadline'), DEADLINE_MS); });
  try {
    const result = await Promise.race([runInner(vendor, rawMessages, guard), deadline]);
    return result === 'deadline' ? finish('deadline') : { aiCalls: 1, ...result };
  } catch (err) {
    return finish(err.message);
  } finally {
    clearTimeout(timer);
  }
}