// Shared helper for the chart server: is the TradingView page live?
// TradingView Essential allows one active session per account. When the owner
// opens TradingView on another device, this browser gets a "Session
// disconnected" dialog and its chart stops loading data.
//
// Policy (2026-10-21, at the owner's request, to avoid a tug-of-war between
// devices): the owner always wins. The server reclaims the session (clicks
// Connect) only after it has been continuously disconnected for at least
// RECLAIM_AFTER_MIN minutes, i.e. the other device has probably gone idle.
// Until then, callers get live:false and skip their work: tv-gate.mjs
// returns a "TradingView in use elsewhere" error to Opus, and
// tv-renew-alerts.cjs tries again the next day.
// TradingView alerts are unaffected either way, because they run on
// TradingView's own servers.
//   node tv-session.cjs    check (and reclaim if the wait is over); prints JSON
const CDP = require('/home/ubuntu/tradingview-mcp/node_modules/chrome-remote-interface');
const fs = require('fs');
const SINCE_FILE = '/home/ubuntu/.tv-disconnected-since';
const RECLAIM_AFTER_MIN = 30;

async function ensureLive() {
  const t = (await CDP.List({ port: 9222 })).find(x => x.type === 'page' && /tradingview\.com/.test(x.url));
  if (!t) return { live: false, note: 'no TradingView tab' };
  const c = await CDP({ port: 9222, target: t });
  try {
    const isDisconnected = async () => (await c.Runtime.evaluate({ expression: `/Session disconnected/i.test(document.body ? document.body.innerText : '')` })).result.value === true;
    if (!(await isDisconnected())) { try { fs.unlinkSync(SINCE_FILE); } catch {} return { live: true }; }

    let since = Date.now();
    try { since = Number(fs.readFileSync(SINCE_FILE, 'utf8')) || since; } catch { fs.writeFileSync(SINCE_FILE, String(since)); }
    const mins = (Date.now() - since) / 60000;
    if (mins < RECLAIM_AFTER_MIN) return { live: false, note: `TradingView is in use on another device (${Math.round(mins)} min) — leaving it alone until it has been idle ${RECLAIM_AFTER_MIN} min` };

    await c.Runtime.evaluate({ expression: `(() => { const b = [...document.querySelectorAll('button')].find(x => /^\\s*Connect\\s*$/i.test(x.textContent)); if (b) b.click(); })()` });
    await new Promise(res => setTimeout(res, 5000));
    const live = !(await isDisconnected());
    if (live) { try { fs.unlinkSync(SINCE_FILE); } catch {} }
    return { live, reconnected: live, note: live ? `reclaimed after ${Math.round(mins)} min idle` : 'Connect clicked but still disconnected' };
  } finally { await c.close(); }
}

module.exports = { ensureLive };
if (require.main === module) ensureLive().then(r => console.log(JSON.stringify(r))).catch(e => console.log(JSON.stringify({ live: false, note: e.message })));
