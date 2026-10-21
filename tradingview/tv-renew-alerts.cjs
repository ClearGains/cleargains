// Keeps the "Opus …" TradingView alerts from expiring (2026-10-21).
// The Essential plan can't make alerts open-ended (they last 2 months at
// most). The chart server's browser is logged into the owner's TradingView
// account, so this runs inside that page and uses TradingView's own alert
// API (list_alerts / modify_restart_alert, the same calls the web app makes)
// to push each Opus alert's expiry out again. A systemd timer runs it daily
// (tv-renew-alerts.timer). It only touches alerts whose name starts "Opus ",
// and only when fewer than RENEW_BELOW_DAYS remain.
//   node tv-renew-alerts.cjs           renew where needed
//   node tv-renew-alerts.cjs --dry     report only
const CDP = require('/home/ubuntu/tradingview-mcp/node_modules/chrome-remote-interface');
const fs = require('fs');
const SECRET_FILE = '/home/ubuntu/.tv-renew-secret';
const RENEW_BELOW_DAYS = Number(process.env.RENEW_BELOW_DAYS ?? 21);   // env override is for testing
const EXTEND_TO_DAYS = 59;   // just under Essential's 2-month maximum
const dry = process.argv.includes('--dry');

(async () => {
  const t = (await CDP.List({ port: 9222 })).find(x => x.type === 'page' && /tradingview\.com/.test(x.url));
  if (!t) throw new Error('no TradingView tab in the chart browser');
  const c = await CDP({ port: 9222, target: t });
  const expr = `(async () => {
    const base = 'https://pricealerts.tradingview.com';
    const list = await (await fetch(base + '/list_alerts', { credentials: 'include' })).json();
    if (list.s !== 'ok') return JSON.stringify({ error: 'list_alerts: ' + JSON.stringify(list).slice(0, 200) });
    const now = Date.now(), day = 86400000;
    const out = [];
    for (const a of list.r.filter(a => /^Opus /.test(a.name || '') && (!${JSON.stringify(process.env.ONLY ?? '')} || a.name === ${JSON.stringify(process.env.ONLY ?? '')}))) {
      const exp = a.expiration ? Date.parse(a.expiration) : null;
      const daysLeft = exp ? (exp - now) / day : null;
      if (a.active && daysLeft !== null && daysLeft >= ${RENEW_BELOW_DAYS}) { out.push({ name: a.name, daysLeft: Math.round(daysLeft), action: 'ok' }); continue; }
      const iso = new Date(now + ${EXTEND_TO_DAYS} * day).toISOString().replace(/\\.\\d{3}Z$/, 'Z');
      if (${dry}) { out.push({ name: a.name, daysLeft: daysLeft === null ? null : Math.round(daysLeft), active: a.active, action: 'would renew to ' + iso }); continue; }
      // Same payload shape TradingView's own edit dialog sends (captured from
      // the web app 2026-10-21). The list_alerts object carries extra
      // read-only fields that the endpoint rejects as invalid_request.
      const payload = {
        conditions: (a.conditions || []).map(cd => ({
          type: cd.type, resolution: cd.resolution,
          series: (cd.series || []).map(s => ({ type: s.type, study: s.study, offsets_by_plot: s.offsets_by_plot, inputs: s.inputs, pine_id: s.pine_id, pine_version: s.pine_version })),
        })),
        symbol: a.symbol, resolution: a.resolution, message: a.message, sound_file: a.sound_file, sound_duration: a.sound_duration,
        popup: a.popup, auto_deactivate: a.auto_deactivate, email: a.email, sms_over_email: a.sms_over_email, mobile_push: a.mobile_push,
        web_hook: a.web_hook, name: a.name, expiration_policy: { policy: 'fixed_date', time: iso.replace('Z', '.000Z') },
        active: true, ignore_warnings: true, alert_id: a.alert_id,
        client_id: 'update_' + Date.now() + '_' + String(Math.floor(Math.random() * 1e13)).padStart(13, '0'),
      };
      const res = await fetch(base + '/modify_restart_alert', { method: 'POST', credentials: 'include', body: JSON.stringify({ payload }) });
      const body = await res.json().catch(() => ({}));
      out.push({ name: a.name, action: body.s === 'ok' ? 'renewed to ' + (body.r?.expiration ?? iso) : 'FAILED ' + res.status + ' ' + JSON.stringify(body).slice(0, 200) });
    }
    // The webhook secret is the Opus script's first input. It's handed back
    // so a failure can still be reported after the session has gone.
    const secret = list.r.find(a => /^Opus /.test(a.name || ''))?.conditions?.[0]?.series?.[0]?.inputs?.in_0 ?? null;
    return JSON.stringify({ count: out.length, out, secret });
  })()`;
  let text;
  try {
    const r = await c.Runtime.evaluate({ awaitPromise: true, expression: expr });
    text = r.result.value ?? JSON.stringify({ error: JSON.stringify(r.exceptionDetails).slice(0, 300) });
  } finally { await c.close(); }
  const res = JSON.parse(text);
  if (res.secret) { fs.writeFileSync(SECRET_FILE, res.secret, { mode: 0o600 }); delete res.secret; }
  console.log(new Date().toISOString(), JSON.stringify(res));
  if (res.error || (res.out || []).some(o => /FAILED/.test(o.action))) await reportFailure(JSON.stringify(res).slice(0, 250));
})().catch(async e => { console.log(new Date().toISOString(), 'ERR', e.message); await reportFailure(e.message); });

// Tell Opus's log (via the normal TradingView webhook route) that renewal
// failed, so it shows on the dashboard instead of the alerts quietly expiring.
async function reportFailure(note) {
  process.exitCode = 1;
  let secret = '';
  try { secret = fs.readFileSync(SECRET_FILE, 'utf8').trim(); } catch {}
  if (!secret || dry) return;
  try {
    await fetch('https://cleargains1.vercel.app/api/tradingview', { method: 'POST', body: JSON.stringify({
      secret, symbol: 'TVALERTS', signal: 'ALERT_RENEW_FAILED', note: String(note).slice(0, 280) }) });
  } catch {}
}
