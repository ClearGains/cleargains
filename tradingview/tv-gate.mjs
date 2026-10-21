// Restricted gateway to the TradingView chart on the ARM server.
// Installed as the forced command for the bot server's SSH key, so the only
// thing that key can do is: "status" or "chart <SYMBOL> <TF> [shot]".
// Prints one JSON object. Serialised with a lock file — there is one chart.
import { execFileSync } from 'child_process';
import fs from 'fs';

const CLI = '/home/ubuntu/tradingview-mcp/src/cli/index.js';
const LOCK = '/tmp/tv-gate.lock';
const args = (process.env.SSH_ORIGINAL_COMMAND ?? process.argv.slice(2).join(' ')).trim().split(/\s+/);

const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const done = obj => { try { fs.unlinkSync(LOCK); } catch {} process.stdout.write(JSON.stringify(obj)); process.exit(0); };
const tv = (...a) => {
  try {
    const raw = execFileSync('node', [CLI, ...a], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
    try { return JSON.parse(raw); } catch { return { raw: raw.slice(0, 500) }; }
  } catch (e) { return { error: String(e.stderr || e.message).slice(0, 300) }; }
};

// Take the lock (wait up to 60s; break a lock older than 2 minutes).
for (let i = 0; ; i++) {
  try { fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' }); break; }
  catch {
    try { if (Date.now() - fs.statSync(LOCK).mtimeMs > 120000) { fs.unlinkSync(LOCK); continue; } } catch {}
    if (i > 120) { process.stdout.write(JSON.stringify({ error: 'chart busy' })); process.exit(0); }
    sleep(500);
  }
}

if (args[0] === 'status') done(tv('status'));
if (args[0] !== 'chart') done({ error: 'unsupported command' });

const [, symbol, tf, shot] = args;
if (!/^[A-Z0-9_!.]{1,20}(:[A-Z0-9_!.]{1,24})?$/.test(symbol ?? '')) done({ error: 'bad symbol' });
if (!['15', '60', '240', 'D', 'W'].includes(tf)) done({ error: 'bad timeframe (15, 60, 240, D, W)' });

tv('symbol', symbol);
tv('timeframe', tf);
// Wait for the new series to load. The quote's symbol flips to the request
// immediately, but its prices stay the OLD series' until the data arrives —
// the description/exchange fields only appear once it has. (Logged out, the
// sign-up popup stops the series ever loading, so this times out.)
let quote = null;
const want = symbol.split(':').pop();
let loaded = false;
for (let i = 0; i < 20 && !loaded; i++) {
  sleep(750);
  quote = tv('quote');
  loaded = Boolean(quote?.symbol && quote.symbol.split(':').pop() === want && quote.description);
}
if (!loaded) done({ error: `chart did not load ${symbol} — wrong symbol, or TradingView is logged out on the server` });
sleep(1000); // let indicators recalculate on the new series
const result = {
  requested: symbol, timeframe: tf,
  quote, summary: tv('ohlcv', '--summary'), indicators: tv('values'),
};
if (shot === 'shot') {
  const s = tv('screenshot', '-r', 'chart');
  if (s?.file_path) {
    try { result.screenshot_png_base64 = fs.readFileSync(s.file_path).toString('base64'); fs.unlinkSync(s.file_path); }
    catch (e) { result.screenshot_error = String(e.message); }
  } else result.screenshot_error = s?.error ?? 'no file';
}
done(result);
