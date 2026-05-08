'use client';

import { useEffect, useRef, useCallback } from 'react';

export type CandleTick = {
  epic:        string;
  time:        string;       // ISO from UTM field
  open:        number;       // mid of bid+offer open
  high:        number;
  low:         number;
  close:       number;       // latest mid price (forming or final)
  bidClose:    number;
  offerClose:  number;
  candleClosed: boolean;     // true when CONS_END=1 (candle complete)
};

type StreamSession = {
  endpoint:      string;   // lightstreamerEndpoint from IG session
  accountId:     string;
  cst:           string;
  securityToken: string;
};

type UseIGStreamOptions = {
  session:  StreamSession | null;
  epics:    string[];
  onTick:   (tick: CandleTick) => void;
  resolution?: '1MINUTE' | '5MINUTE' | 'HOUR';
};

// Dynamically import Lightstreamer to avoid SSR issues
async function getLightstreamer() {
  const mod = await import('lightstreamer-client-web');
  return mod.default ?? mod;
}

export function useIGStream({ session, epics, onTick, resolution = '1MINUTE' }: UseIGStreamOptions) {
  const clientRef      = useRef<unknown>(null);
  const subRef         = useRef<unknown>(null);
  const onTickRef      = useRef(onTick);
  const connectedRef   = useRef(false);

  // Keep onTick ref current without reconnecting
  useEffect(() => { onTickRef.current = onTick; }, [onTick]);

  const disconnect = useCallback(() => {
    try {
      if (subRef.current && clientRef.current) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (clientRef.current as any).unsubscribe(subRef.current);
      }
    } catch {}
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (clientRef.current as any)?.disconnect();
    } catch {}
    clientRef.current = null;
    subRef.current    = null;
    connectedRef.current = false;
  }, []);

  useEffect(() => {
    if (!session || epics.length === 0) { disconnect(); return; }

    let cancelled = false;

    void (async () => {
      try {
        const LS = await getLightstreamer();
        if (cancelled) return;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const LSClient       = (LS as any).LightstreamerClient;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const LSSubscription = (LS as any).Subscription;

        const client = new LSClient(session.endpoint, 'DEFAULT') as {
          connectionDetails: { setUser(u: string): void; setPassword(p: string): void };
          connect(): void;
          disconnect(): void;
          subscribe(s: unknown): void;
          unsubscribe(s: unknown): void;
        };

        client.connectionDetails.setUser(session.accountId);
        // IG Lightstreamer auth: "CST-{cst}|XST-{securityToken}"
        client.connectionDetails.setPassword(`CST-${session.cst}|XST-${session.securityToken}`);
        client.connect();
        clientRef.current = client;

        // Subscribe to 1-minute candle items for each epic
        const items = epics.map(e => `CHART:${e}:${resolution}`);
        const fields = [
          'UTM',           // timestamp ms
          'BID_OPEN', 'BID_HIGH', 'BID_LOW', 'BID_CLOSE',
          'OFR_OPEN', 'OFR_HIGH', 'OFR_LOW', 'OFR_CLOSE',
          'CONS_END',      // '1' = candle complete, '0' = forming
        ];

        const sub = new LSSubscription('MERGE', items, fields);

        sub.addListener({
          onItemUpdate(update: {
            getItemName(): string;
            getValue(f: string): string | null;
          }) {
            const itemName = update.getItemName();         // "CHART:IX.D.FTSE.DAILY.IP:1MINUTE"
            const epic = itemName.split(':')[1] ?? '';

            const g = (f: string) => parseFloat(update.getValue(f) ?? '0') || 0;

            const bidOpen  = g('BID_OPEN');
            const bidHigh  = g('BID_HIGH');
            const bidLow   = g('BID_LOW');
            const bidClose = g('BID_CLOSE');
            const ofrOpen  = g('OFR_OPEN');
            const ofrHigh  = g('OFR_HIGH');
            const ofrLow   = g('OFR_LOW');
            const ofrClose = g('OFR_CLOSE');
            const utmMs    = parseFloat(update.getValue('UTM') ?? '0') || Date.now();
            const consEnd  = update.getValue('CONS_END') === '1';

            const tick: CandleTick = {
              epic,
              time:         new Date(utmMs).toISOString(),
              open:         (bidOpen  + ofrOpen)  / 2,
              high:         (bidHigh  + ofrHigh)  / 2,
              low:          (bidLow   + ofrLow)   / 2,
              close:        (bidClose + ofrClose) / 2,
              bidClose,
              offerClose:   ofrClose,
              candleClosed: consEnd,
            };

            onTickRef.current(tick);
          },
        });

        client.subscribe(sub);
        subRef.current = sub;
        connectedRef.current = true;
      } catch (e) {
        console.error('[IGStream] connection error:', e);
      }
    })();

    return () => {
      cancelled = true;
      disconnect();
    };
  // Re-connect only when session/epics/resolution change
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.cst, session?.endpoint, epics.join(','), resolution]);

  return { disconnect };
}
