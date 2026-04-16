/**
 * @deprecated  Use GET /api/sync/load instead.
 * This stub keeps old bookmarks/cached calls working by forwarding to the new route.
 */
import { NextRequest } from 'next/server';
import { GET as loadHandler } from '../load/route';

export const GET = (req: NextRequest) => loadHandler(req);
