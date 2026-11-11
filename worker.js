import widgetCode from  './frontend.min.js'
export default {
  async fetch(request, env, ctx) {
    // Your finalized frontend.js code embedded right here as a string
    return new Response(widgetCode, {
      headers: {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Cache-Control': 'public, max-age=3600', // Cache at Cloudflare's edge for 1 hour
      },
    });
  },
};