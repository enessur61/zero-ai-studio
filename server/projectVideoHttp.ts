import { Readable } from 'node:stream';
import type { Request, Response } from 'express';
import type { ProjectVideoAsset } from './projectVideoStore.ts';

export interface OpenProjectVideoStream extends ProjectVideoAsset {
  chunksForRange: (start?: number, end?: number) => AsyncIterable<Buffer>;
  close: () => Promise<void>;
}

export type ProjectVideoRange =
  | { kind: 'full'; start: number; end: number }
  | { kind: 'partial'; start: number; end: number }
  | { kind: 'invalid' };

export function parseProjectVideoRange(
  header: string | undefined,
  size: number,
  ifRange: string | undefined,
  etag: string,
): ProjectVideoRange {
  const full = { kind: 'full' as const, start: 0, end: size - 1 };
  if (!header || (ifRange && ifRange !== etag)) return full;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2]) || size < 1) return { kind: 'invalid' };
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { kind: 'invalid' };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) {
      return { kind: 'invalid' };
    }
    end = Math.min(end, size - 1);
  }
  return { kind: 'partial', start, end };
}

export interface ProjectVideoStreamTimeouts { idleTimeoutMs?: number; maxLifetimeMs?: number }
export function sendProjectVideoStream(
  req: Request, res: Response, asset: OpenProjectVideoStream, download = false,
  timeouts: ProjectVideoStreamTimeouts = {},
): Response {
  const idleTimeoutMs = timeouts.idleTimeoutMs ?? 30_000;
  const maxLifetimeMs = timeouts.maxLifetimeMs ?? 600_000;
  const etag = `"${asset.sha256}"`;
  const range = parseProjectVideoRange(
    req.headers.range,
    asset.sizeBytes,
    typeof req.headers['if-range'] === 'string' ? req.headers['if-range'] : undefined,
    etag,
  );
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Type', asset.contentType);
  res.setHeader(
    'Content-Disposition',
    `${download ? 'attachment' : 'inline'}; filename="zero-clip-${asset.id}.${asset.contentType === 'video/webm' ? 'webm' : 'mp4'}"`,
  );
  if (range.kind === 'invalid') {
    void asset.close();
    res.setHeader('Content-Range', `bytes */${asset.sizeBytes}`);
    return res.status(416).end();
  }
  const length = range.end - range.start + 1;
  res.setHeader('Content-Length', String(length));
  if (range.kind === 'partial') {
    res.status(206);
    res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${asset.sizeBytes}`);
  }
  const body = Readable.from(asset.chunksForRange(range.start, range.end), { objectMode: false });
  let closed = false;
  const cleanup = () => { if (closed) return; closed = true; clearTimeout(lifetimeTimer); res.setTimeout(0); };
  const terminate = (message: string) => {
    if (closed) return;
    cleanup(); body.destroy(new Error(message)); void asset.close();
    if (!res.destroyed) res.destroy();
  };
  const lifetimeTimer = setTimeout(() => terminate('Project video stream exceeded its maximum lifetime.'), maxLifetimeMs);
  res.setTimeout(idleTimeoutMs, () => terminate('Project video stream was idle for too long.'));
  res.once('finish', cleanup);
  res.once('close', () => { cleanup(); if (!res.writableEnded) { body.destroy(); void asset.close(); } });
  body.once('error', (error) => {
    cleanup(); void asset.close();
    if (!res.headersSent) res.status(500).end();
    else if (!res.destroyed) res.destroy(error);
  });
  body.pipe(res);
  return res;
}
