"""
IG Momentum Bot ("Momentum Testbot") — Python port of the ClearGains "Testbot"
=============================================================================
Ported from the ClearGains repo as it was on 16 April 2026
(commit 57d82e8: components/ig/IGStrategyTrader.tsx and app/api/ig/candles/route.ts),
the version that placed the 16-17 April demo trades.

Original logic, unchanged:
  1. Every 5 minutes, get each market's price and previous close from
     Yahoo Finance (same symbols, same request) and work out today's % change.
  2. Signal: change > +0.3% -> BUY   change < -0.3% -> SELL   else no trade
  3. Strength from the size of the move:
       Index     : >=1.0% 85  >=0.5% 75  >=0.3% 65  below: scaled (pct/0.3 * 60)
       Forex     : >=0.3% 85  >=0.2% 75  >=0.1% 65  below: scaled (pct/0.1 * 60)
       Commodity : >=2.0% 85  >=1.0% 75  >=0.5% 65  below: scaled (pct/0.5 * 60)
       Crypto    : >=3.0% 85  >=2.0% 75  >=1.0% 65  below: scaled (pct/1.0 * 60)
     Trade if strength >= MIN_STRENGTH (default 60) or strength >= 90.
  4. Fixed stop / limit sent with every order, so IG closes trades:
       Index 20/40 pts, Forex 20/40, Commodity 2/4, Crypto 50/100
  5. Size: SIZE_PER_POINT, capped at 5% of available funds (rounded down to 0.1),
     0.1 if available is under £500, no trading under £100.
  6. Reversal: if the signal flips against an open position in that market,
     close it first (AUTO_CLOSE=true, as in the original).

Fix (the glitch): the original's "already open in this direction" check read
stale data, so it opened the same trade on every scan. Open positions are
fetched fresh from IG every scan, so each market gets at most one position.

Separation (2026-10-29, added when reinstated on the main bot server): this
bot shares the IG demo account with Opus and other bots. It only ever looks
at, and closes, deals it opened itself (own_deals.json). Every deal it opens
is also appended to deal_history.json, which the bot server reads to label
these trades "Momentum Testbot" and to keep Opus from ever adopting them.

Choppy-day guard (2026-10-29, owner's request): on a day with no clear
direction the original kept re-entering and getting stopped out. Per market:
  - after a losing trade, no new trade in that market for COOLDOWN_MINUTES (60);
  - after MAX_LOSSES_PER_DAY (2) losing trades in a UTC day, that market
    pauses for LONG_PAUSE_MINUTES (180) from the latest loss (owner, 29 Oct:
    a whole day was too long, markets often settle and trend again later).
A trade closed by IG (stop or limit) counts as a loss when the market's
current price is on the losing side of the entry.

Stale prices (2026-10-29, owner's request): Yahoo keeps showing a closed
market's last session move, so the original was betting on yesterday's US
move during the UK morning. An index now trades only while its home exchange
is in its regular session and Yahoo's price is under MAX_QUOTE_AGE_MINUTES (30)
old. FX quotes round the clock and is unaffected.

Stops sized to the market (2026-10-29): the original used 20/40 points on
every index. At today's prices that is 0.03% on Japan 225 (whose spread alone
is ~9 points) and 0.08% on Germany 40, so ordinary noise stopped trades out.
Index stop = INDEX_STOP_PCT (0.3%, the same as the signal threshold) of price,
target = twice that (the original's 1:2), and the size is set so a stop-out
loses about RISK_PER_TRADE_GBP (£20, the original's £1/pt x 20 pts). FX keeps
the original 20/40 pips, which already fit FX's smaller moves.

Conviction filters (2026-10-29, owner: "more conviction to minimise the
losses"). On top of the original signal, a trade also needs:
  - strength >= MIN_STRENGTH, now 75 by default (an index must be up or down
    0.5% on the day, not 0.3%; FX already needs 0.3%, which scores 85);
  - the move still holding: price above today's open for a BUY, below for a
    SELL (CONFIRM_INTRADAY);
  - the trend agreeing: price above its 20-day average for a BUY, below for a
    SELL (TREND_FILTER);
  - for indices, not in the first OPENING_SKIP_MINUTES (30) of the exchange's
    session, the noisiest part of the day.
Each can be switched off in .env.
  - after a trade hits its profit target, no new trade in that market for
    WAIT_AFTER_WIN_MINUTES (45): on 29 Oct it bought Germany 40 straight back
    after every target (25,894 -> 25,940 -> 26,016 -> 26,054), chasing an
    already stretched move.

US 500 stops sized to its swings (2026-10-29, owner: the US 500 is
choppy with rapid moves that hit tight stops; change for the US 500 ONLY).
A market with its own stop_atr_frac rule gets a stop of the larger of
INDEX_STOP_PCT and stop_atr_frac x its 14-day average daily range. Every
other market keeps the flat INDEX_STOP_PCT (STOP_ATR_FRAC defaults to 0).
Size still targets ~RISK_PER_TRADE_GBP, so a wider stop means a smaller stake.

Per-market rules (MARKET_RULES, JSON in .env), stricter for the US 500 by
default: a 1%+ day move (strength 85), no trades in the first 60 minutes of
the US session, and a stop of 0.6 x the daily range.

Left out on purpose (never fired in the IG history, or not part of the signal):
  - +50% size boost on correlated markets
  - Closing other markets' positions to make room for a "15% stronger" signal
  - Per-market "Trade always" test switch

Safety: IG_ENV=demo by default; live needs IG_ENV=live and I_UNDERSTAND_LIVE=yes.
DRY_RUN=true logs decisions without placing orders. KILL_SWITCH=true pauses new bets.
"""
import csv
import json
import logging
import math
import os
import sys
import time
from datetime import datetime, timezone

import requests
from dotenv import load_dotenv, dotenv_values

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ENV_PATH = os.path.join(BASE_DIR, ".env")
load_dotenv(ENV_PATH)

# IG demo login: taken from the bot server's own .env (the same demo account),
# so nobody has to type credentials again. A value in this bot's .env wins.
BOT_SERVER_ENV = os.path.expanduser(os.getenv("BOT_SERVER_ENV", "~/nexustrade/bot-server/.env"))

# ── Settings ────────────────────────────────────────────────────────────────
SCAN_INTERVAL_SECONDS = int(os.getenv("SCAN_INTERVAL_SECONDS", "300"))
SIZE_PER_POINT = float(os.getenv("SIZE_PER_POINT", "1"))
MIN_STRENGTH = int(os.getenv("MIN_STRENGTH", "75"))
CONFIRM_INTRADAY = os.getenv("CONFIRM_INTRADAY", "true").strip().lower() in ("1", "true", "yes")
TREND_FILTER = os.getenv("TREND_FILTER", "true").strip().lower() in ("1", "true", "yes")
OPENING_SKIP_MINUTES = int(os.getenv("OPENING_SKIP_MINUTES", "30"))
AUTO_CLOSE = os.getenv("AUTO_CLOSE", "true").strip().lower() in ("1", "true", "yes")
COOLDOWN_MINUTES = int(os.getenv("COOLDOWN_MINUTES", "60"))
LONG_PAUSE_MINUTES = int(os.getenv("LONG_PAUSE_MINUTES", "180"))
MAX_LOSSES_PER_DAY = int(os.getenv("MAX_LOSSES_PER_DAY", "2"))
WAIT_AFTER_WIN_MINUTES = int(os.getenv("WAIT_AFTER_WIN_MINUTES", "45"))
MAX_QUOTE_AGE_MINUTES = int(os.getenv("MAX_QUOTE_AGE_MINUTES", "30"))
RISK_PER_TRADE_GBP = float(os.getenv("RISK_PER_TRADE_GBP", "25"))   # sets the stake
STOP_GBP = float(os.getenv("STOP_GBP", "20"))   # stop placed at this £ loss for the stake (0 = use the computed stop)
TARGET_R = float(os.getenv("TARGET_R", "0.4"))   # £10 target / £25 risk (trial)
INDEX_STOP_PCT = float(os.getenv("INDEX_STOP_PCT", "0.3"))
STOP_ATR_FRAC = float(os.getenv("STOP_ATR_FRAC", "0"))   # 0 = off for all markets except those with their own rule (owner: US 500 only)
try:
    # Owner, 29 Oct: US 500 at £1/pt with a 25-point stop and 45-point target
    # (£25 loss / £45 profit): the 23-point stop was hit before correct calls
    # had time to play out. 30 Oct (owner): US 500 and FTSE 100 halved to
    # £0.50/pt with the same point distances (US 500 20/10, FTSE 26/13).
    MARKET_RULES = json.loads(os.getenv("MARKET_RULES", '{"S&P 500": {"min_strength": 85, "opening_skip": 60, "stop_pts": 20, "target_pts": 10, "size": 0.5}, "FTSE 100": {"stop_pts": 26, "target_pts": 13, "size": 0.5}}'))
except ValueError:
    MARKET_RULES = {}
SIGNAL_THRESHOLD_PCT = 0.3
CURRENCY = "GBP"

# name, epic, type, yahoo symbol, enabled by default
# Enabled = the markets that traded on 16-17 April.
ALL_MARKETS = [
    ("FTSE 100",      "IX.D.FTSE.DAILY.IP",    "INDEX",     "^FTSE",     True),
    ("S&P 500",       "IX.D.SPTRD.DAILY.IP",   "INDEX",     "^GSPC",     True),
    ("NASDAQ 100",    "IX.D.NASDAQ.DAILY.IP",  "INDEX",     "^IXIC",     False),
    ("Wall Street",   "IX.D.DOW.DAILY.IP",     "INDEX",     "^DJI",      True),
    ("Germany 40",    "IX.D.DAX.DAILY.IP",     "INDEX",     "^GDAXI",    True),
    ("Japan 225",     "IX.D.NIKKEI.DAILY.IP",  "INDEX",     "^N225",     True),
    ("Australia 200", "IX.D.ASX.DAILY.IP",     "INDEX",     "^AXJO",     False),
    ("Gold",          "CS.D.GOLD.TODAY.IP",    "COMMODITY", "GC=F",      False),
    ("Silver",        "CS.D.SILVER.TODAY.IP",  "COMMODITY", "SI=F",      False),
    ("Oil (WTI)",     "CS.D.CRUDE.TODAY.IP",   "COMMODITY", "CL=F",      False),
    ("GBP/USD",       "CS.D.GBPUSD.TODAY.IP",  "FOREX",     "GBPUSD=X",  True),
    ("EUR/USD",       "CS.D.EURUSD.TODAY.IP",  "FOREX",     "EURUSD=X",  False),
    ("USD/JPY",       "CS.D.USDJPY.TODAY.IP",  "FOREX",     "JPY=X",     False),
    ("EUR/GBP",       "CS.D.EURGBP.TODAY.IP",  "FOREX",     "EURGBP=X",  False),
    ("AUD/USD",       "CS.D.AUDUSD.TODAY.IP",  "FOREX",     "AUDUSD=X",  True),
    ("USD/CHF",       "CS.D.USDCHF.TODAY.IP",  "FOREX",     "USDCHF=X",  False),
    ("Bitcoin",       "CS.D.BITCOIN.TODAY.IP", "CRYPTO",    "BTC-USD",   False),
]

# Owner, 29 Oct: every trade risks £25 and targets £45 (was £20/£40), for more
# room. FX at £1/pt: 25/45 pips. Indices keep their stop distance; the stake is
# sized for a £25 loss and the target set for a £45 win (TARGET_R = 1.8).
# Trial from 29 Oct evening (owner): keep the £25 stop, take profit at £10 so
# gains are banked faster (needs ~72%+ of trades to win to break even).
STOP_LIMIT = {"INDEX": (25, 10), "FOREX": (25, 10), "COMMODITY": (2, 4), "CRYPTO": (50, 100)}

# (band threshold %, strength) high to low, plus the scale used below the lowest band
BANDS = {
    "INDEX":     ([(1.0, 85), (0.5, 75), (0.3, 65)], 0.3),
    "FOREX":     ([(0.3, 85), (0.2, 75), (0.1, 65)], 0.1),
    "COMMODITY": ([(2.0, 85), (1.0, 75), (0.5, 65)], 0.5),
    "CRYPTO":    ([(3.0, 85), (2.0, 75), (1.0, 65)], 1.0),
}

YAHOO_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json",
}

# ── Logging / records ───────────────────────────────────────────────────────
LOG_FILE = os.path.join(BASE_DIR, "ig_momentum_bot.log")
TRADES_CSV = os.path.join(BASE_DIR, "trades.csv")
OWN_DEALS = os.path.join(BASE_DIR, "own_deals.json")        # deals this bot has open now
DEAL_HISTORY = os.path.join(BASE_DIR, "deal_history.json")  # every deal it ever opened
CHOP_GUARD = os.path.join(BASE_DIR, "chop_guard.json")      # losses per market today

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    handlers=[logging.FileHandler(LOG_FILE), logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger("ig_bot")


def read_json(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def write_json(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=1)
    os.replace(tmp, path)


# ── Strategy (pure functions) ───────────────────────────────────────────────
def raw_signal(change_pct: float) -> str:
    if change_pct > SIGNAL_THRESHOLD_PCT:
        return "BUY"
    if change_pct < -SIGNAL_THRESHOLD_PCT:
        return "SELL"
    return "NEUTRAL"


def strength_for(mtype: str, change_pct: float) -> int:
    bands, scale = BANDS[mtype]
    pct = abs(change_pct)
    for threshold, value in bands:
        if pct >= threshold:
            return value
    return min(64, max(0, round(pct / scale * 60)))


def decide(mtype: str, change_pct: float, min_strength: int = None):
    """Return (direction or None, strength), exactly as the original."""
    min_strength = MIN_STRENGTH if min_strength is None else min_strength
    sig = raw_signal(change_pct)
    strength = strength_for(mtype, change_pct)
    if sig == "NEUTRAL":
        return None, strength
    if strength >= min_strength or strength >= 90:
        return sig, strength
    return None, strength


def dynamic_size(requested: float, available: float) -> float:
    """calcDynamicSize from the original: cap at 5% of available funds."""
    if available < 100:
        return 0.0
    if available < 500:
        return 0.1
    pct_based = math.floor(available * 0.05 * 10) / 10
    return max(0.01, min(requested, pct_based))


# ── Market data (same Yahoo request as the original) ────────────────────────
def yahoo_change(symbol: str, http=requests):
    url = ("https://query1.finance.yahoo.com/v8/finance/chart/"
           + requests.utils.quote(symbol, safe="") + "?interval=1d&range=2mo")
    r = http.get(url, headers=YAHOO_HEADERS, timeout=15)
    if r.status_code != 200:
        return None
    result = (r.json().get("chart", {}).get("result") or [None])[0]
    if not result:
        return None
    meta = result.get("meta", {})
    price = meta.get("regularMarketPrice")
    quote = ((result.get("indicators") or {}).get("quote") or [{}])[0]
    opens = quote.get("open") or []
    closes = [c for c in (quote.get("close") or []) if c is not None]
    # Previous close: Yahoo's own figure when given, else the bar before today
    # (with a 2-month range Yahoo omits previousClose).
    prev = meta.get("previousClose") or (closes[-2] if len(closes) >= 2 else None)
    if not price or not prev:
        return None
    extra = {
        "price": price,
        "today_open": opens[-1] if opens else None,
        "sma20": sum(closes[-20:]) / 20 if len(closes) >= 20 else None,
        "atr_pct": atr_pct(quote),
        "session_start": ((meta.get("currentTradingPeriod") or {}).get("regular") or {}).get("start"),
    }
    return (price - prev) / prev * 100, staleness(meta), extra


def atr_pct(quote):
    """14-day average true range as % of the last close, or None."""
    hs, ls, cs = quote.get("high") or [], quote.get("low") or [], quote.get("close") or []
    bars = [(h, l, c) for h, l, c in zip(hs, ls, cs) if None not in (h, l, c)]
    if len(bars) < 15:
        return None
    trs = []
    for i in range(1, len(bars)):
        h, l, _ = bars[i]
        pc = bars[i - 1][2]
        trs.append(max(h - l, abs(h - pc), abs(l - pc)))
    atr = sum(trs[-14:]) / 14
    return atr / bars[-1][2] * 100


def staleness(meta):
    """Why this quote is stale (its exchange is shut or the price is old), or None."""
    now = time.time()
    regular = (meta.get("currentTradingPeriod") or {}).get("regular") or {}
    start, end = regular.get("start"), regular.get("end")
    if start and end and not (start <= now <= end):
        return "its exchange is closed, so Yahoo is showing the last session's move"
    t = meta.get("regularMarketTime")
    if t and now - t > MAX_QUOTE_AGE_MINUTES * 60:
        return f"Yahoo's price is {int((now - t) / 60)} min old"
    return None


# ── IG REST client ──────────────────────────────────────────────────────────
class IGClient:
    def __init__(self, username, password, api_key, account_id, env):
        self.username = username
        self.password = password
        self.api_key = api_key
        self.account_id = account_id
        self.base = ("https://demo-api.ig.com/gateway/deal" if env == "demo"
                     else "https://api.ig.com/gateway/deal")
        self.cst = None
        self.xst = None
        self.logged_in_at = 0.0
        self.http = requests.Session()

    def _headers(self, version="1", extra=None):
        h = {
            "X-IG-API-KEY": self.api_key,
            "Content-Type": "application/json; charset=UTF-8",
            "Accept": "application/json; charset=UTF-8",
            "Version": version,
        }
        if self.cst:
            h["CST"] = self.cst
            h["X-SECURITY-TOKEN"] = self.xst
        if extra:
            h.update(extra)
        return h

    def login(self):
        self.cst = self.xst = None
        r = self.http.post(self.base + "/session", headers=self._headers("2"),
                           json={"identifier": self.username, "password": self.password}, timeout=20)
        if r.status_code != 200:
            raise RuntimeError(f"IG login failed ({r.status_code}): {r.text[:300]}")
        self.cst = r.headers.get("CST")
        self.xst = r.headers.get("X-SECURITY-TOKEN")
        current = r.json().get("currentAccountId")
        if self.account_id and current != self.account_id:
            s = self.http.put(self.base + "/session", headers=self._headers("1"),
                              json={"accountId": self.account_id, "defaultAccount": False}, timeout=20)
            if s.status_code != 200 and self.account_id not in s.text:
                raise RuntimeError(f"Switch to account {self.account_id} failed "
                                   f"({s.status_code}): {s.text[:300]}")
            if s.headers.get("X-SECURITY-TOKEN"):
                self.xst = s.headers["X-SECURITY-TOKEN"]
        self.logged_in_at = time.time()
        log.info(f"Logged in to IG {'demo' if 'demo' in self.base else 'LIVE'} "
                 f"(account {self.account_id or current})")

    def _request(self, method, path, version="1", extra=None, **kw):
        if not self.cst or time.time() - self.logged_in_at > 6 * 3600:
            self.login()
        r = self.http.request(method, self.base + path,
                              headers=self._headers(version, extra), timeout=20, **kw)
        if r.status_code == 401:
            log.warning("IG session expired, logging in again")
            self.login()
            r = self.http.request(method, self.base + path,
                                  headers=self._headers(version, extra), timeout=20, **kw)
        return r

    def markets(self, epics):
        r = self._request("GET", "/markets", "2", params={"epics": ",".join(epics)})
        r.raise_for_status()
        return {d["instrument"]["epic"]: d for d in r.json().get("marketDetails", [])}

    def search(self, term):
        r = self._request("GET", "/markets", "1", params={"searchTerm": term})
        r.raise_for_status()
        return r.json().get("markets", [])

    def positions(self):
        r = self._request("GET", "/positions", "2")
        r.raise_for_status()
        out = []
        for p in r.json().get("positions", []):
            pos = p["position"]
            out.append({"epic": p["market"]["epic"], "dealId": pos["dealId"],
                        "direction": pos["direction"], "size": pos["size"],
                        "level": pos.get("level"), "created": pos.get("createdDateUTC")})
        return out

    def available_funds(self):
        r = self._request("GET", "/accounts", "1")
        r.raise_for_status()
        accounts = r.json().get("accounts", [])
        acc = (next((a for a in accounts if a.get("accountId") == self.account_id), None)
               or next((a for a in accounts if a.get("preferred")), None))
        bal = (acc or {}).get("balance", {})
        return bal.get("available"), bal.get("balance")

    def _confirm(self, ref):
        for _ in range(5):
            time.sleep(1)
            c = self._request("GET", f"/confirms/{ref}", "1")
            if c.status_code == 200:
                return c.json()
        return {"dealStatus": "UNKNOWN", "reason": "no confirmation", "dealReference": ref}

    def open_position(self, epic, direction, size, stop, limit):
        body = {"epic": epic, "expiry": "DFB", "direction": direction, "size": size,
                "orderType": "MARKET", "guaranteedStop": False, "forceOpen": True,
                "currencyCode": CURRENCY, "stopDistance": stop, "limitDistance": limit}
        r = self._request("POST", "/positions/otc", "2", json=body)
        if r.status_code != 200:
            return {"dealStatus": "ERROR", "reason": f"{r.status_code} {r.text[:200]}"}
        return self._confirm(r.json().get("dealReference"))

    def close_position(self, pos):
        body = {"dealId": pos["dealId"], "size": pos["size"], "orderType": "MARKET",
                "direction": "BUY" if pos["direction"] == "SELL" else "SELL"}
        # IG's close endpoint is a DELETE with a body, sent as POST + _method header
        r = self._request("POST", "/positions/otc", "1", extra={"_method": "DELETE"}, json=body)
        if r.status_code != 200:
            return {"dealStatus": "ERROR", "reason": f"{r.status_code} {r.text[:200]}"}
        return self._confirm(r.json().get("dealReference"))


# ── Bot ─────────────────────────────────────────────────────────────────────
def env_flag(name, default="false"):
    load_dotenv(ENV_PATH, override=True)  # re-read so KILL_SWITCH / DRY_RUN apply live
    return os.getenv(name, default).strip().lower() in ("1", "true", "yes")


def selected_markets():
    wanted = os.getenv("MARKETS", "").strip()
    if wanted:
        names = [n.strip().lower() for n in wanted.split(",")]
        return [m[:4] for m in ALL_MARKETS if m[0].lower() in names]
    return [m[:4] for m in ALL_MARKETS if m[4]]


def resolve_epics(ig, markets):
    found = ig.markets([m[1] for m in markets])
    resolved = []
    for name, epic, mtype, sym in markets:
        if epic in found:
            resolved.append((name, epic, mtype, sym))
            continue
        match = next((x for x in ig.search(name) if x.get("expiry") == "DFB"), None)
        if match:
            log.info(f"{name}: {epic} not found, using {match['epic']}")
            resolved.append((name, match["epic"], mtype, sym))
        else:
            log.warning(f"{name}: no spread bet market found, skipping")
    return resolved


def record_trade(row):
    new = not os.path.exists(TRADES_CSV)
    with open(TRADES_CSV, "a", newline="") as f:
        w = csv.writer(f)
        if new:
            w.writerow(["time_utc", "action", "market", "epic", "direction", "size",
                        "strength", "change_pct", "level", "stop_level", "limit_level",
                        "status", "reason", "deal_id"])
        w.writerow(row)


def now_utc():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def remember_deal(name, epic, direction, size, level, deal_id):
    own = read_json(OWN_DEALS, {})
    own[deal_id] = {"market": name, "epic": epic, "direction": direction, "size": size,
                    "level": level, "opened_utc": now_utc()}
    write_json(OWN_DEALS, own)
    hist = read_json(DEAL_HISTORY, [])
    hist.append({"dealId": deal_id, **own[deal_id]})
    write_json(DEAL_HISTORY, hist)


def today_utc():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def record_loss(market):
    g = read_json(CHOP_GUARD, {})
    if g.get("date") != today_utc():
        g = {"date": today_utc(), "markets": {}}
    m = g["markets"].setdefault(market, {"losses": 0, "last_loss": 0})
    m["losses"] += 1
    m["last_loss"] = time.time()
    write_json(CHOP_GUARD, g)
    log.info(f"{market}: loss {m['losses']} of {MAX_LOSSES_PER_DAY} allowed today"
             + (f"; pausing {LONG_PAUSE_MINUTES} min" if m["losses"] >= MAX_LOSSES_PER_DAY else f"; pausing {COOLDOWN_MINUTES} min"))


def record_win(market):
    g = read_json(CHOP_GUARD, {})
    if g.get("date") != today_utc():
        g = {"date": today_utc(), "markets": {}}
    m = g["markets"].setdefault(market, {"losses": 0, "last_loss": 0})
    m["last_win"] = time.time()
    write_json(CHOP_GUARD, g)
    log.info(f"{market}: target hit; waiting {WAIT_AFTER_WIN_MINUTES} min before re-entering")


def chop_block(market):
    """Reason this market is blocked by the choppy-day guard, or None."""
    g = read_json(CHOP_GUARD, {})
    if g.get("date") != today_utc():
        return None
    m = g.get("markets", {}).get(market)
    if not m:
        return None
    pause = LONG_PAUSE_MINUTES if m["losses"] >= MAX_LOSSES_PER_DAY else COOLDOWN_MINUTES
    left = pause - (time.time() - m["last_loss"]) / 60
    if left > 0 and m["losses"] >= MAX_LOSSES_PER_DAY:
        return f"{m['losses']} losses today, pausing {LONG_PAUSE_MINUTES} min after the latest, {left:.0f} min left"
    if left > 0:
        return f"cooling off after a loss, {left:.0f} min left"
    left = WAIT_AFTER_WIN_MINUTES - (time.time() - m.get("last_win", 0)) / 60
    if left > 0:
        return f"waiting after a target hit (no chasing), {left:.0f} min left"
    return None


def conviction_block(mtype, direction, extra, opening_skip=None):
    """Why the move isn't convincing enough to trade, or None."""
    price, today_open, sma20 = extra.get("price"), extra.get("today_open"), extra.get("sma20")
    start = extra.get("session_start")
    skip = OPENING_SKIP_MINUTES if opening_skip is None else opening_skip
    if mtype == "INDEX" and skip > 0 and start and time.time() - start < skip * 60:
        return f"first {skip} min of the session (opening noise)"
    if CONFIRM_INTRADAY and today_open:
        if direction == "BUY" and price <= today_open:
            return f"fading: price {price:g} is not above today's open {today_open:g}"
        if direction == "SELL" and price >= today_open:
            return f"fading: price {price:g} is not below today's open {today_open:g}"
    if TREND_FILTER and sma20:
        if direction == "BUY" and price <= sma20:
            return f"against the trend: price {price:g} is below its 20-day average {sma20:.5g}"
        if direction == "SELL" and price >= sma20:
            return f"against the trend: price {price:g} is above its 20-day average {sma20:.5g}"
    return None


def find_unconfirmed_open(ig, epic, direction, known_ids):
    """IG sometimes answers an order with an error or no confirmation even
    though it opened. Look for a deal in that market and direction, opened in
    the last two minutes, that nobody has claimed."""
    time.sleep(2.5)
    for p in ig.positions():
        if p["epic"] != epic or p["direction"] != direction or p["dealId"] in known_ids:
            continue
        created = p.get("created")
        if created:
            try:
                age = (datetime.now(timezone.utc)
                       - datetime.fromisoformat(created.replace("Z", "")).replace(tzinfo=timezone.utc))
                if age.total_seconds() > 120:
                    continue
            except ValueError:
                pass
        return p
    return None


def other_bot_deal_ids():
    """Deals the bot server knows belong to other bots (Opus). Best effort."""
    try:
        state = read_json(os.path.expanduser("~/nexustrade/bot-server/opus-state.json"), {})
        return {p.get("brokerRef") for p in state.get("positions", [])}
    except Exception:
        return set()


def scan(ig, markets, dry_run, http=requests):
    ig_info = ig.markets([m[1] for m in markets])
    all_pos = ig.positions()
    open_ids = {p["dealId"] for p in all_pos}

    # Only this bot's own deals count. Anything that has disappeared was
    # closed at the broker (stop or limit hit, or closed by hand).
    own = read_json(OWN_DEALS, {})
    for deal_id in [d for d in own if d not in open_ids]:
        o = own.pop(deal_id)
        snap = (ig_info.get(o["epic"]) or {}).get("snapshot", {})
        exit_px = snap.get("bid") if o["direction"] == "BUY" else snap.get("offer")
        lost = None
        if exit_px is not None and o.get("level") is not None:
            lost = exit_px < o["level"] if o["direction"] == "BUY" else exit_px > o["level"]
        outcome = "loss (stop)" if lost else "win (limit)" if lost is False else "unknown"
        log.info(f"{o['market']}: {o['direction']} {deal_id} closed at the broker, {outcome}")
        record_trade([now_utc(), "CLOSED_AT_BROKER", o["market"], o["epic"], o["direction"], o["size"],
                      "", "", exit_px, "", "", "CLOSED", f"stop/limit hit or closed outside the bot: {outcome}", deal_id])
        if lost:
            record_loss(o["market"])
        elif lost is False:
            record_win(o["market"])
    write_json(OWN_DEALS, own)
    open_pos = [p for p in all_pos if p["dealId"] in own]

    available, _ = ig.available_funds()
    available = float(available) if available is not None else math.inf

    for name, epic, mtype, sym in markets:
        info = ig_info.get(epic)
        status = (info or {}).get("snapshot", {}).get("marketStatus")
        if status != "TRADEABLE":
            log.info(f"{name:13} market {status or 'unavailable'}")
            continue
        try:
            quote = yahoo_change(sym, http)
        except Exception as e:
            quote = None
            log.warning(f"{name}: Yahoo error {e}")
        if quote is None:
            log.warning(f"{name:13} no Yahoo price, skipped this scan")
            continue
        change, stale, extra = quote
        if stale and mtype != "FOREX":
            log.info(f"{name:13} {change:+.2f}% not traded: {stale}")
            continue

        rules = MARKET_RULES.get(name, {})
        direction, strength = decide(mtype, change, rules.get("min_strength"))
        tag = f"{name:13} {change:+.2f}% strength {strength:>2}"
        if not direction:
            log.info(f"{tag} HOLD")
            continue
        mine = [p for p in open_pos if p["epic"] == epic]
        if any(p["direction"] == direction for p in mine):
            log.info(f"{tag} {direction} already open, skip")
            continue
        blocked = chop_block(name) or conviction_block(mtype, direction, extra, rules.get("opening_skip"))
        if blocked:
            log.info(f"{tag} {direction} skipped: {blocked}")
            continue
        if env_flag("KILL_SWITCH"):
            log.warning("Kill switch on, not placing new bets")
            return

        # Reversal: close this bot's opposite position first (original autoClose)
        for opp in [p for p in mine if p["direction"] != direction]:
            if not AUTO_CLOSE:
                break
            if dry_run:
                log.info(f"{tag} would close {opp['direction']} {opp['dealId']} (signal reversed) [DRY RUN]")
            else:
                res = ig.close_position(opp)
                log.info(f"{tag} closed {opp['direction']} (signal reversed) -> "
                         f"{res.get('dealStatus')} {res.get('reason')} P&L {res.get('profit')}")
                record_trade([now_utc(), "CLOSE", name, epic, opp["direction"], opp["size"],
                              strength, round(change, 3), res.get("level"), None, None,
                              res.get("dealStatus"), res.get("reason"), opp["dealId"]])
                if res.get("dealStatus") == "ACCEPTED":
                    profit = res.get("profit")
                    if isinstance(profit, (int, float)) and profit < 0:
                        record_loss(name)
                    open_pos = [p for p in open_pos if p["dealId"] != opp["dealId"]]
                    own = read_json(OWN_DEALS, {})
                    own.pop(opp["dealId"], None)
                    write_json(OWN_DEALS, own)

        stop, limit = STOP_LIMIT[mtype]
        requested = SIZE_PER_POINT
        if rules.get("stop_pts"):
            # Fixed points and stake for this market (owner's choice).
            stop, limit = rules["stop_pts"], rules.get("target_pts", rules["stop_pts"] * 2)
            requested = rules.get("size", SIZE_PER_POINT)
        elif mtype == "INDEX":
            snap = (info or {}).get("snapshot", {})
            px = snap.get("offer") if direction == "BUY" else snap.get("bid")
            if px:
                atr = (extra or {}).get("atr_pct")
                frac = rules.get("stop_atr_frac", STOP_ATR_FRAC)
                stop_pct = max(INDEX_STOP_PCT, frac * atr) if atr else INDEX_STOP_PCT
                stop = max(round(px * stop_pct / 100), 1)
                limit = max(round(stop * TARGET_R), 1)
                rules = (info or {}).get("dealingRules", {})
                min_size = (rules.get("minDealSize") or {}).get("value") or 0.04
                requested = max(min_size, math.floor(RISK_PER_TRADE_GBP / stop * 100) / 100)
        size = dynamic_size(requested, available)
        if size == 0:
            log.error(f"Available funds £{available:.2f} under £100, pausing new bets")
            return
        # Owner, 30 Oct: stop at a £20 loss. Same stake and same £10 target;
        # only the stop moves closer.
        # Markets with their own fixed points and size keep them as set.
        if STOP_GBP > 0 and not rules.get("stop_pts"):
            stop = max(1, round(STOP_GBP / size))
        if dry_run:
            log.info(f"{tag} {direction} £{size}/pt SL {stop} TP {limit} [DRY RUN, not placed]")
            continue

        res = ig.open_position(epic, direction, size, stop, limit)
        if res.get("dealStatus") != "ACCEPTED":
            known = set(read_json(OWN_DEALS, {})) | other_bot_deal_ids()
            stray = find_unconfirmed_open(ig, epic, direction, known)
            if stray:
                log.info(f"{tag} IG said {res.get('dealStatus')} {res.get('reason')} but deal "
                         f"{stray['dealId']} did open; tracking it")
                res = {"dealStatus": "ACCEPTED", "reason": "opened despite IG error",
                       "dealId": stray["dealId"], "level": stray.get("level")}
        log.info(f"{tag} {direction} £{size}/pt SL {stop} TP {limit} -> "
                 f"{res.get('dealStatus')} {res.get('reason')} level={res.get('level')}")
        record_trade([now_utc(), "OPEN", name, epic, direction, size, strength,
                      round(change, 3), res.get("level"), res.get("stopLevel"),
                      res.get("limitLevel"), res.get("dealStatus"), res.get("reason"),
                      res.get("dealId")])
        if res.get("dealStatus") == "ACCEPTED" and res.get("dealId"):
            remember_deal(name, epic, direction, size, res.get("level"), res["dealId"])
            open_pos.append({"epic": epic, "dealId": res["dealId"], "direction": direction,
                             "size": size, "level": res.get("level")})


def credential(name, server_name):
    """This bot's .env first, then the bot server's demo login."""
    v = os.getenv(name, "").strip()
    if v:
        return v
    return (dotenv_values(BOT_SERVER_ENV).get(server_name) or "").strip()


def main():
    env = os.getenv("IG_ENV", "demo").strip().lower()
    if env not in ("demo", "live"):
        sys.exit("IG_ENV must be demo or live")
    if env == "live" and os.getenv("I_UNDERSTAND_LIVE", "").strip().lower() != "yes":
        sys.exit("Refusing to trade LIVE. Set I_UNDERSTAND_LIVE=yes in .env if you really mean it.")
    if env == "demo":
        creds = {k: credential(k, s) for k, s in
                 [("IG_USERNAME", "IG_DEMO_USERNAME"), ("IG_PASSWORD", "IG_DEMO_PASSWORD"),
                  ("IG_API_KEY", "IG_DEMO_API_KEY")]}
    else:
        creds = {k: os.getenv(k, "").strip() for k in ("IG_USERNAME", "IG_PASSWORD", "IG_API_KEY")}
    missing = [k for k, v in creds.items() if not v]
    if missing:
        sys.exit(f"Missing IG login: {', '.join(missing)}")

    ig = IGClient(creds["IG_USERNAME"], creds["IG_PASSWORD"], creds["IG_API_KEY"],
                  os.getenv("IG_ACC_NUMBER", "").strip(), env)
    ig.login()
    markets = resolve_epics(ig, selected_markets())
    available, balance = ig.available_funds()
    log.info(f"Started | {env.upper()} | balance £{balance} available £{available} | "
             f"markets: {', '.join(m[0] for m in markets)} | £{SIZE_PER_POINT}/pt | "
             f"min strength {MIN_STRENGTH} | auto close {AUTO_CLOSE} | dry run {env_flag('DRY_RUN', 'true')}")
    while True:
        if env_flag("KILL_SWITCH"):
            log.warning("Kill switch on, idle")
        else:
            try:
                scan(ig, markets, env_flag("DRY_RUN", "true"))
            except Exception as e:
                log.error(f"Scan failed: {e}")
        time.sleep(SCAN_INTERVAL_SECONDS)


if __name__ == "__main__":
    main()
