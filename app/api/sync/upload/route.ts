/**
 * @deprecated  Use POST /api/sync/save instead.
 * This stub keeps old bookmarks/cached calls working by forwarding to the new route.
 */
import { NextRequest } from 'next/server';
import { POST as saveHandler } from '../save/route';

export const POST = (req: NextRequest) => saveHandler(req);
