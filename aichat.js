// ==UserScript==
// @name         AI Sales Assistant (test)
// @namespace    http://tampermonkey.net/
// @version      2.2
// @description  Crystal-orb AI shopping assistant widget
// @match        https://nordicknives.com/*
// @match        https://www.nordicknives.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      zrok.io
// @connect      onrender.com
// ==/UserScript==
(function () {
  'use strict';
  if (window.__aiSalesAssistant) return;
  window.__aiSalesAssistant = true;

  /* ---------- Settings (a <script data-vendor data-backend> tag overrides these) ---------- */
  const tag = document.currentScript;
  const CFG = {
    backend: (tag && tag.dataset.backend) || 'https://sales-ecom-assistant.onrender.com',
    vendor: (tag && tag.dataset.vendor) || 'nordic-knives',
  };
  const KEY = 'aisa:' + CFG.vendor;
  const BOT = '<i class="scr"><span class="eyes"><b class="eye"></b><b class="eye"></b></span></i>';
  const KEEP = 30, SEND_LAST = 10, TTL = 24 * 3600 * 1000, TIMEOUT = 70000;
  const ERR_TEXT = "I couldn't reach the store just now. Please try again in a moment.";
  let starters = ['Show me bestsellers', 'Help me find a gift', "What's on sale?"];

  /* ---------- Network ----------
     In Tampermonkey (testing) requests go through GM_xmlhttpRequest, which skips CORS and can send the
     zrok bypass header. On a real site (script tag) it uses plain fetch(). */
  function api(path, init) {
    init = init || {};
    if (typeof GM_xmlhttpRequest === 'function') {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: init.method || 'GET', url: CFG.backend + path, data: init.body, timeout: TIMEOUT,
          headers: Object.assign({ skip_zrok_interstitial: '1' }, init.headers || {}),
          onload: (r) => resolve({ ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => JSON.parse(r.responseText) }),
          onerror: reject, ontimeout: () => reject(new Error('timeout')),
        });
      });
    }
    return fetch(CFG.backend + path, init);
  }

  /* ---------- State (kept in the shopper's browser only) ---------- */
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 's' + Math.random().toString(36).slice(2));
  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY));
      if (s && s.sid && Date.now() - s.t < TTL) return s;
    } catch (e) {}
    return { sid: uid(), items: [], strikes: 0, t: Date.now() };
  }
  const state = load();
  function save() {
    state.t = Date.now();
    state.items = state.items.slice(-KEEP);
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
  }
  function track(name, data) {
    try { window.umami && window.umami.track && window.umami.track(name, Object.assign({ vendor: CFG.vendor }, data || {})); } catch (e) {}
  }

  /* ---------- Styles ---------- */
  const CSS = `
:host{all:initial}
*{box-sizing:border-box;margin:0;padding:0}
.root{--a:#6ea8ff;--b:#9d7bff;--c:#ff8fb1;--ink:#1b1d24;--mute:#6b7280;--line:#e9ebf2;--soft:#f4f5fa;--ease:cubic-bezier(.32,.72,0,1);
  font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:var(--ink);-webkit-font-smoothing:antialiased}
button{font:inherit;color:inherit;border:0;background:none;cursor:pointer}
:focus-visible{outline:2px solid var(--b);outline-offset:2px}

/* Glossy bot */
.gem{--s:64px;position:relative;width:var(--s);height:var(--s);border-radius:50%;overflow:hidden;flex:none;
  background:radial-gradient(circle at 50% 110%,#7fe0ff 0,rgba(127,224,255,0) 55%),linear-gradient(165deg,#74b6ff 0%,#2f6df0 48%,#1a3fb8 100%);
  box-shadow:inset 0 calc(var(--s)*-.1) calc(var(--s)*.2) rgba(8,24,110,.55),inset 0 calc(var(--s)*.03) calc(var(--s)*.06) rgba(255,255,255,.55)}
.gem::before{content:"";position:absolute;z-index:3;pointer-events:none;top:4%;left:14%;width:72%;height:44%;border-radius:50%;
  background:linear-gradient(180deg,rgba(255,255,255,.85),rgba(255,255,255,.06))}
.scr{position:absolute;z-index:1;left:17%;right:17%;top:41%;height:33%;border-radius:999px;overflow:hidden;
  background:linear-gradient(180deg,#071a55,#12318a);box-shadow:inset 0 calc(var(--s)*.03) calc(var(--s)*.05) rgba(0,0,0,.55),0 calc(var(--s)*.012) 0 rgba(255,255,255,.35)}
.eyes{position:absolute;inset:0;transform:translate(calc(var(--ex,0)*var(--s)*.055),calc(var(--ey,0)*var(--s)*.03));transition:transform .28s cubic-bezier(.3,.7,.2,1)}
.eye{position:absolute;top:50%;margin-top:calc(var(--s)*-.07);width:calc(var(--s)*.085);height:calc(var(--s)*.14);border-radius:99px;background:#d8fbff;
  box-shadow:0 0 calc(var(--s)*.09) #6fe3ff;animation:blink 5.5s infinite}
.eye:nth-child(1){left:26%}.eye:nth-child(2){right:26%}
.gem.sm{--s:28px}.gem.xs{--s:24px}.gem.lg{--s:56px}
@keyframes blink{0%,94%,100%{transform:scaleY(1)}97%{transform:scaleY(.1)}}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes bob{50%{transform:translateY(-3px)}}

.orb{position:fixed;right:24px;bottom:24px;width:64px;height:64px;border-radius:50%;transition:transform .45s var(--ease),opacity .3s}
.orb::before{content:"";position:absolute;inset:-12px;border-radius:50%;z-index:-1;filter:blur(16px);opacity:.55;
  background:conic-gradient(#4f8dff,#3fd0ff,#8a7bff,#4f8dff);animation:spin 10s linear infinite}
.orb .gem{position:absolute;inset:0;animation:bob 4.5s ease-in-out infinite;
  box-shadow:inset 0 -8px 14px rgba(8,24,110,.55),inset 0 2px 4px rgba(255,255,255,.55),0 12px 26px rgba(40,90,230,.45)}
.orb:hover{transform:scale(1.08)}.orb:active{transform:scale(.95)}

.teaser{position:fixed;right:96px;bottom:24px;height:64px;max-width:240px;display:flex;align-items:center;pointer-events:none}
.tb{position:relative;background:#fff;border-radius:18px;padding:11px 15px;font-size:13.5px;line-height:1.4;
  box-shadow:0 12px 32px -10px rgba(30,40,110,.35),0 0 0 1px rgba(20,20,60,.06);
  opacity:0;transform:translateX(14px) scale(.85);transform-origin:right center;transition:opacity .3s,transform .5s var(--ease)}
.tb::after{content:"";position:absolute;right:-5px;top:50%;width:11px;height:11px;margin-top:-5px;background:#fff;transform:rotate(45deg);border-radius:2px}
.teaser.show .tb{opacity:1;transform:none;pointer-events:auto;cursor:pointer}
.tb .dots{padding:3px 0}

/* Panel */
.panel{position:fixed;right:24px;bottom:104px;width:392px;height:min(640px,calc(100dvh - 128px));display:flex;flex-direction:column;
  background:#fff;border-radius:28px;overflow:hidden;box-shadow:0 30px 70px -14px rgba(30,30,90,.35),0 0 0 1px rgba(20,20,60,.06);
  transform-origin:bottom right;opacity:0;visibility:hidden;transform:translateY(14px) scale(.9);
  transition:transform .5s var(--ease),opacity .25s,visibility 0s .5s}
.root.open .panel{opacity:1;visibility:visible;transform:none;transition:transform .5s var(--ease),opacity .3s,visibility 0s}
.head{display:flex;align-items:center;gap:10px;padding:14px 14px 12px 18px}
.head .t{flex:1;min-width:0}
.head b{display:block;font-size:15px;font-weight:600;letter-spacing:-.2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.head span{font-size:12px;color:var(--mute)}
.x{width:34px;height:34px;border-radius:50%;display:grid;place-items:center;color:var(--mute);transition:background .2s}
.x:hover{background:var(--soft)}

.feed{flex:1;overflow-y:auto;padding:6px 20px 14px;display:flex;flex-direction:column;gap:16px;scrollbar-width:thin;scrollbar-color:#d6d9e4 transparent;overscroll-behavior:contain}
.hello{margin:auto 0;padding:10px 0 0;display:flex;flex-direction:column;gap:10px}
.hello .gem{margin-bottom:4px}
.hello h2{font-size:30px;line-height:1.1;font-weight:600;letter-spacing:-.8px;width:fit-content;
  background:linear-gradient(100deg,var(--a),var(--b) 55%,var(--c));-webkit-background-clip:text;background-clip:text;color:transparent}
.hello p{font-size:15px;color:var(--mute);line-height:1.45;max-width:30ch}
.me{align-self:flex-end;max-width:84%;background:#edf1fe;padding:10px 15px;border-radius:20px 20px 6px 20px;font-size:14.5px;line-height:1.45;overflow-wrap:anywhere;animation:rise .35s var(--ease)}
.bot{display:flex;gap:10px;align-items:flex-start;animation:rise .35s var(--ease)}
.bot .gem{margin-top:2px}
.bot .txt{font-size:14.5px;line-height:1.55;overflow-wrap:anywhere;white-space:pre-wrap;min-width:0}
@keyframes rise{from{opacity:0;transform:translateY(8px)}}

.rail-wrap{position:relative;margin:2px -20px 0}
.rail{display:flex;gap:10px;overflow-x:auto;scroll-snap-type:x mandatory;scroll-padding-left:20px;padding:4px 20px 8px 52px;scrollbar-width:none}
.rail::-webkit-scrollbar{display:none}
.card{flex:0 0 158px;scroll-snap-align:start;display:flex;flex-direction:column;text-decoration:none;color:inherit;background:#fff;border-radius:18px;overflow:hidden;
  box-shadow:0 0 0 1px var(--line);transition:transform .3s var(--ease),box-shadow .3s}
.card:hover{transform:translateY(-3px);box-shadow:0 0 0 1px #cfd3e6,0 12px 24px -10px rgba(40,40,110,.25)}
.pic{aspect-ratio:1;background:linear-gradient(135deg,#eef0fa,#f7f1fa);display:grid;place-items:center}
.pic img{width:100%;height:100%;object-fit:cover;display:block}
.info{padding:10px 12px 12px;display:flex;flex-direction:column;gap:6px;flex:1}
.nm{font-size:13px;font-weight:550;line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:34px}
.pr{font-size:15px;font-weight:650;letter-spacing:-.2px}
.pr small{font-size:11px;font-weight:500;color:#b4472f;margin-left:6px}
.go{margin-top:auto;text-align:center;font-size:12.5px;font-weight:600;padding:8px;border-radius:12px;color:#fff;background:linear-gradient(100deg,#5b8def,var(--b))}
.arrow{position:absolute;top:38%;width:32px;height:32px;border-radius:50%;background:#fff;box-shadow:0 4px 14px rgba(30,30,90,.2);display:none;place-items:center;z-index:2;transition:opacity .2s}
.arrow.l{left:56px}.arrow.r{right:12px}
@media (hover:hover){.rail-wrap:hover .arrow{display:grid}}

.chips{display:flex;flex-wrap:wrap;gap:8px;animation:rise .35s var(--ease)}
.bot+.chips,.rail-wrap+.chips{padding-left:38px}
.chip{padding:8px 14px;border-radius:18px;font-size:13px;background:#fff;box-shadow:0 0 0 1px var(--line);transition:background .2s,transform .2s var(--ease)}
.chip:hover{background:var(--soft);transform:translateY(-1px)}

.dots{display:flex;gap:5px;padding:9px 0}
.dots i{width:7px;height:7px;border-radius:50%;background:linear-gradient(135deg,var(--a),var(--c));animation:hop 1.1s ease-in-out infinite}
.dots i:nth-child(2){animation-delay:.15s}.dots i:nth-child(3){animation-delay:.3s}
@keyframes hop{0%,60%,100%{transform:none;opacity:.45}30%{transform:translateY(-5px);opacity:1}}
.wait{font-size:12px;color:var(--mute);padding-top:7px}

.foot{padding:8px 16px calc(10px + env(safe-area-inset-bottom,0px))}
.box{display:flex;align-items:center;gap:6px;background:var(--soft);border-radius:26px;padding:5px 5px 5px 18px;box-shadow:0 0 0 1px transparent;transition:box-shadow .25s,background .25s}
.box:focus-within{background:#fff;box-shadow:0 0 0 1.5px var(--b),0 6px 20px -8px rgba(110,90,240,.4)}
.box input{flex:1;min-width:0;border:0;outline:0;background:none;font:inherit;font-size:16px;padding:9px 0;color:var(--ink)}
.box input::placeholder{color:#9aa0b0}
.send{width:38px;height:38px;border-radius:50%;display:grid;place-items:center;color:#fff;background:linear-gradient(135deg,#5b8def,var(--b));transition:transform .25s var(--ease),opacity .2s}
.send:hover{transform:scale(1.07)}.send:disabled{opacity:.3;transform:none;cursor:default}
.note{font-size:11px;color:#9aa0b0;text-align:center;padding-top:7px}

/* Tablet: large, but not full screen */
@media (min-width:481px) and (max-width:1024px){
  .panel{width:min(560px,82vw);height:min(780px,calc(100dvh - 128px));right:20px}
  .card{flex-basis:180px}
}
/* Mobile: fills the screen */
@media (max-width:480px){
  .panel{inset:0;width:100%;height:100dvh;border-radius:0;transform:translateY(40px)}
  .head{padding-top:calc(14px + env(safe-area-inset-top,0px))}
  .root.open .orb,.root.open .teaser{opacity:0;pointer-events:none;transform:scale(.6)}
  .orb{right:16px;bottom:16px}.teaser{right:88px;bottom:16px;max-width:calc(100vw - 110px)}
}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition-duration:.01ms!important}}
`;

  /* ---------- Markup ---------- */
  const host = document.createElement('div');
  host.id = 'ai-sales-root';
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>${CSS}</style>
<div class="root" id="root">
  <div class="teaser" id="teaser"><div class="tb" id="tb"></div></div>
  <button class="orb" id="orb" aria-label="Open shopping assistant" aria-expanded="false"><span class="gem">${BOT}</span></button>
  <section class="panel" id="panel" role="dialog" aria-label="Shopping assistant">
    <header class="head">
      <span class="gem sm">${BOT}</span>
      <div class="t"><b id="title">Shopping assistant</b><span>AI shopping assistant</span></div>
      <button class="x" id="close" aria-label="Close chat"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
    </header>
    <div class="feed" id="feed" aria-live="polite"></div>
    <footer class="foot">
      <div class="box">
        <input id="input" type="text" placeholder="Ask about any product" autocomplete="off" maxlength="500" aria-label="Message">
        <button class="send" id="send" aria-label="Send" disabled><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg></button>
      </div>
      <p class="note">AI can make mistakes. Check details on the product page.</p>
    </footer>
  </section>
</div>`;
  document.body.appendChild(host);

  const $ = (id) => shadow.getElementById(id);
  const rootEl = $('root'), feed = $('feed'), input = $('input'), sendBtn = $('send');
  let busy = false, welcomeText = "Ask me about products, prices, or help choosing.";

  /* ---------- Helpers ---------- */
  const el = (tagName, cls, text) => {
    const n = document.createElement(tagName);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const safeUrl = (u) => { try { const x = new URL(u, location.href); return /^https?:$/.test(x.protocol) ? x.href : null; } catch (e) { return null; } };
  function money(p) {
    const n = Number(p.price);
    if (!Number.isFinite(n)) return '';
    try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: p.currency || 'USD' }).format(n); }
    catch (e) { return (p.currency ? p.currency + ' ' : '') + n.toFixed(2); }
  }
  const gemEl = (cls) => { const g = el('span', 'gem ' + cls); g.innerHTML = BOT; return g; };
  const toEnd = () => requestAnimationFrame(() => { feed.scrollTo({ top: feed.scrollHeight, behavior: 'smooth' }); });
  const mobile = () => matchMedia('(max-width:480px)').matches;

  /* ---------- Rendering ---------- */
  function chipsEl(list) {
    const wrap = el('div', 'chips');
    list.forEach((t) => {
      const b = el('button', 'chip', t);
      b.addEventListener('click', () => send(t));
      wrap.appendChild(b);
    });
    return wrap;
  }
  function rail(products) {
    const wrap = el('div', 'rail-wrap');
    const r = el('div', 'rail');
    products.forEach((p) => {
      const href = safeUrl(p.url);
      const a = el('a', 'card');
      if (href) { a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; }
      a.addEventListener('click', () => track('product_clicked', { product: String(p.id || p.title).slice(0, 80) }));
      const pic = el('div', 'pic');
      const img = safeUrl(p.imageUrl);
      if (img) {
        const i = el('img'); i.src = img; i.alt = ''; i.loading = 'lazy';
        i.addEventListener('error', () => i.remove());
        pic.appendChild(i);
      }
      const info = el('div', 'info');
      info.appendChild(el('div', 'nm', p.title || 'Product'));
      const pr = el('div', 'pr', money(p));
      if (p.inStock === false) pr.appendChild(el('small', '', 'Sold out'));
      info.appendChild(pr);
      info.appendChild(el('span', 'go', 'View item'));
      a.append(pic, info);
      r.appendChild(a);
    });
    const mk = (cls, d) => {
      const b = el('button', 'arrow ' + cls);
      b.setAttribute('aria-label', d < 0 ? 'Previous' : 'Next');
      b.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="${d < 0 ? 'M15 5l-7 7 7 7' : 'M9 5l7 7-7 7'}"/></svg>`;
      b.addEventListener('click', () => r.scrollBy({ left: d * 340, behavior: 'smooth' }));
      return b;
    };
    wrap.append(r);
    if (products.length > 2) wrap.append(mk('l', -1), mk('r', 1));
    return wrap;
  }
  function drawItem(it) {
    if (it.role === 'user') { feed.appendChild(el('div', 'me', it.text)); return; }
    const row = el('div', 'bot');
    row.append(gemEl('xs'), el('div', 'txt', it.text));
    feed.appendChild(row);
    if (it.products && it.products.length) feed.appendChild(rail(it.products));
  }
  function drawWelcome() {
    const h = el('div', 'hello');
    h.id = 'hello';
    h.append(gemEl('lg'), el('h2', '', 'Hi there'), el('p', '', welcomeText), chipsEl(starters));
    feed.appendChild(h);
  }
  function renderAll() {
    feed.textContent = '';
    if (!state.items.length) { drawWelcome(); return; }
    state.items.forEach(drawItem);
    const last = state.items[state.items.length - 1];
    if (last.role === 'assistant' && last.chips && last.chips.length) feed.appendChild(chipsEl(last.chips));
    feed.scrollTop = feed.scrollHeight;
  }
  function typing() {
    const row = el('div', 'bot'); row.id = 'typing';
    const col = el('div');
    const d = el('div', 'dots'); d.append(el('i'), el('i'), el('i'));
    col.appendChild(d);
    row.append(gemEl('xs'), col);
    feed.appendChild(row);
    toEnd();
    const t = setTimeout(() => { col.appendChild(el('div', 'wait', 'Warming up, this first reply can take a little longer.')); toEnd(); }, 7000);
    return () => { clearTimeout(t); row.remove(); };
  }

  /* ---------- Sending ---------- */
  async function send(raw) {
    const text = String(raw || '').trim();
    if (!text || busy) return;
    busy = true; sendBtn.disabled = true; input.value = '';
    shadow.getElementById('hello')?.remove();
    feed.querySelectorAll('.chips').forEach((c) => c.remove());
    const userItem = { role: 'user', text };
    state.items.push(userItem); save(); drawItem(userItem);
    track('message_sent');
    const stop = typing();
    const ctrl = new AbortController();
    const kill = setTimeout(() => ctrl.abort(), TIMEOUT);
    let reply;
    try {
      const res = await api('/chat', {
        method: 'POST', signal: ctrl.signal,
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, // avoids the browser's preflight check (faster, fewer CORS problems)
        body: JSON.stringify({
          vendorId: CFG.vendor, sessionId: state.sid, pageUrl: location.href, strikes: state.strikes || 0,
          messages: state.items.filter((i) => !i.err).slice(-SEND_LAST).map((i) => ({ role: i.role, content: i.text })),
        }),
      });
      let data = {};
      try { data = await res.json(); } catch (e) {}
      if (!res.ok || !data.reply) console.warn('[ai-sales] /chat status', res.status, data);
      if (!data.reply) throw new Error('no reply (status ' + res.status + ')');
      if (Number.isFinite(data.strikes)) state.strikes = data.strikes;
      reply = { role: 'assistant', text: String(data.reply), products: (data.products || []).slice(0, 8), chips: (data.chips || []).slice(0, 4) };
    } catch (e) {
      console.warn('[ai-sales] /chat request failed:', e);
      reply = { role: 'assistant', text: ERR_TEXT, err: true };
    }
    clearTimeout(kill); stop();
    state.items.push(reply); save(); drawItem(reply);
    if (reply.products && reply.products.length) track('products_shown', { count: reply.products.length });
    if (reply.chips && reply.chips.length) feed.appendChild(chipsEl(reply.chips));
    toEnd();
    busy = false; sendBtn.disabled = !input.value.trim();
  }

  /* ---------- Open / close ---------- */
  let prevOverflow = '';
  function setOpen(open) {
    rootEl.classList.toggle('open', open);
    $('orb').setAttribute('aria-expanded', String(open));
    $('teaser').classList.remove('show');
    if (open) {
      track('chat_opened');
      if (mobile()) { prevOverflow = document.documentElement.style.overflow; document.documentElement.style.overflow = 'hidden'; }
      else setTimeout(() => input.focus(), 350);
      feed.scrollTop = feed.scrollHeight;
    } else {
      document.documentElement.style.overflow = prevOverflow;
    }
  }
  const isOpen = () => rootEl.classList.contains('open');
  $('orb').addEventListener('click', () => setOpen(!isOpen()));
  $('close').addEventListener('click', () => setOpen(false));
  $('teaser').addEventListener('click', () => setOpen(true));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen()) setOpen(false); });
  input.addEventListener('input', () => { sendBtn.disabled = busy || !input.value.trim(); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) send(input.value); });
  sendBtn.addEventListener('click', () => send(input.value));

  /* ---------- Config from your backend (also wakes it up) ---------- */
  renderAll();
  api('/config/' + encodeURIComponent(CFG.vendor))
    .then((r) => r.json())
    .then((c) => {
      if (c.name) $('title').textContent = c.name;
      const w = c.widgetConfig || {};
      if (w.welcomeMessage) welcomeText = w.welcomeMessage;
      if (Array.isArray(w.starters) && w.starters.length) starters = w.starters.slice(0, 4);
      if (w.colors) ['a', 'b', 'c'].forEach((k) => w.colors[k] && rootEl.style.setProperty('--' + k, w.colors[k]));
      if (Array.isArray(w.greetings) && w.greetings.length) greetings = w.greetings.slice(0, 4);
      if (!state.items.length) renderAll();
    })
    .catch((e) => console.warn('[ai-sales] /config request failed:', e));

  /* ---------- Eyes: follow the cursor, glance around when idle ---------- */
  let lastMove = 0, raf = 0;
  const look = (x, y) => { rootEl.style.setProperty('--ex', x.toFixed(2)); rootEl.style.setProperty('--ey', y.toFixed(2)); };
  addEventListener('pointermove', (e) => {
    lastMove = Date.now();
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const r = $('orb').getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
      look(Math.max(-1, Math.min(1, dx / 280)), Math.max(-1, Math.min(1, dy / 280)));
    });
  }, { passive: true });
  setInterval(() => {
    if (document.hidden || Date.now() - lastMove < 3000) return;
    const center = Math.random() < 0.3;
    look(center ? 0 : Math.random() * 2 - 1, center ? 0 : Math.random() * 1.2 - 0.6);
  }, 2200);

  /* ---------- Greeting bubble: up to 3 short messages per visit ---------- */
  let greetings = ["Hi! Is there anything you're looking for?", 'I can help you find the right product.', "Ask me about prices, sizes or what's in stock."];
  let gi = 0, greets = 0;
  try { greets = +sessionStorage.getItem('aisa:greets') || 0; } catch (e) {}
  const teaser = $('teaser'), tb = $('tb');
  function greet() {
    if (isOpen() || greets >= 3 || state.items.length) return;
    greets++;
    try { sessionStorage.setItem('aisa:greets', String(greets)); } catch (e) {}
    tb.innerHTML = '<div class="dots"><i></i><i></i><i></i></div>';
    teaser.classList.add('show');
    look(-0.9, -0.1);
    setTimeout(() => { if (!isOpen()) tb.textContent = greetings[gi++ % greetings.length]; }, 900);
    setTimeout(() => teaser.classList.remove('show'), 8000);
    setTimeout(greet, 26000);
  }
  setTimeout(greet, 3500);
})();