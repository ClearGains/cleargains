import { LightstreamerClient, Subscription } from 'lightstreamer-client-node';
import type { CandleTick } from './scalperStrategy';
import type { IGSession } from './igApi';

type OnTickFn = (tick: CandleTick) => void;

let client: InstanceType<typeof LightstreamerClient> | null = null;
let sub:    InstanceType<typeof Subscription> | null = null;
let connected = false;

export function isConnected() { return connected; }

export function connect(session: IGSession, epics: string[], onTick: OnTickFn, resolution = '1MINUTE') {
  disconnect();

  const ls = new LightstreamerClient(session.lightstreamerEndpoint, 'DEFAULT');
  ls.connectionDetails.setUser(session.accountId);
  ls.connectionDetails.setPassword(`CST-${session.cst}|XST-${session.securityToken}`);

  ls.addListener({
    onStatusChange(status: string) {
      connected = status.startsWith('CONNECTED');
      console.log(`[igStream] status: ${status}`);
    },
    onServerError(code: number, msg: string) {
      console.error(`[igStream] server error ${code}: ${msg}`);
    },
  });

  ls.connect();
  client = ls;

  const items  = epics.map(e => `CHART:${e}:${resolution}`);
  const fields = ['UTM', 'BID_OPEN', 'BID_HIGH', 'BID_LOW', 'BID_CLOSE', 'OFR_OPEN', 'OFR_HIGH', 'OFR_LOW', 'OFR_CLOSE', 'CONS_END'];

  const subscription = new Subscription('MERGE', items, fields);

  subscription.addListener({
    onItemUpdate(update: { getItemName(): string; getValue(f: string): string | null }) {
      const epic = update.getItemName().split(':')[1] ?? '';
      const g = (f: string) => parseFloat(update.getValue(f) ?? '0') || 0;

      const bidOpen  = g('BID_OPEN');
      const bidClose = g('BID_CLOSE');
      const ofrOpen  = g('OFR_OPEN');
      const ofrClose = g('OFR_CLOSE');
      const utmMs    = parseFloat(update.getValue('UTM') ?? '0') || Date.now();

      const tick: CandleTick = {
        epic,
        time:         new Date(utmMs).toISOString(),
        open:         (bidOpen  + ofrOpen)  / 2,
        high:         (g('BID_HIGH') + g('OFR_HIGH')) / 2,
        low:          (g('BID_LOW')  + g('OFR_LOW'))  / 2,
        close:        (bidClose + ofrClose) / 2,
        bidClose,
        offerClose:   ofrClose,
        candleClosed: update.getValue('CONS_END') === '1',
      };

      onTick(tick);
    },
  });

  ls.subscribe(subscription);
  sub = subscription;
  console.log(`[igStream] Subscribed to ${epics.length} epic(s): ${epics.join(', ')}`);
}

export function disconnect() {
  try { if (sub && client) client.unsubscribe(sub); } catch {}
  try { client?.disconnect(); } catch {}
  client    = null;
  sub       = null;
  connected = false;
  console.log('[igStream] Disconnected');
}
