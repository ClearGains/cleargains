import { LightstreamerClient, Subscription } from 'lightstreamer-client-node';
import type { CandleTick } from './scalperStrategy';
import type { IGSession } from './igApi';

type OnTickFn = (tick: CandleTick) => void;

const BATCH_SIZE = 6;  // subscribe in groups of 6 to avoid hitting IG limits

let client: InstanceType<typeof LightstreamerClient> | null = null;
let subs:   Array<InstanceType<typeof Subscription>> = [];
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

  const fields = ['UTM', 'BID_OPEN', 'BID_HIGH', 'BID_LOW', 'BID_CLOSE', 'OFR_OPEN', 'OFR_HIGH', 'OFR_LOW', 'OFR_CLOSE', 'CONS_END'];

  // Split epics into batches of BATCH_SIZE
  for (let i = 0; i < epics.length; i += BATCH_SIZE) {
    const batch = epics.slice(i, i + BATCH_SIZE);
    const items = batch.map(e => `CHART:${e}:${resolution}`);

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
    subs.push(subscription);
  }

  console.log(`[igStream] Subscribed to ${epics.length} epic(s) in ${subs.length} batch(es)`);
}

export function disconnect() {
  try {
    if (client) {
      for (const s of subs) { try { client.unsubscribe(s); } catch {} }
    }
  } catch {}
  try { client?.disconnect(); } catch {}
  client    = null;
  subs      = [];
  connected = false;
  console.log('[igStream] Disconnected');
}
