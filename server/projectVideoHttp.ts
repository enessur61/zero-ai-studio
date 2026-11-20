import { Readable } from 'node:stream';
import type { Request, Response } from 'express';
import type { ProjectVideoAsset } from './projectVideoStore.ts';

export interface OpenProjectVideoStream extends ProjectVideoAsset {
  chunks: AsyncIterable<Buffer>;
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

export function sendProjectVideoStream(
  req: Request,
  res: Response,
  asset: OpenProjectVideoStream,
  download = false,
): Response {
  const etag = `"${asset.sha256}"`;
  const range = parseProjectVideoRange(
    req.headers.range,
    asset.sizeBytes,
    req.headers['if-range'],
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
  const body = Readable.from(asset.chunks, { objectMode: false });
  res.once('close', () => {
    if (!res.writableEnded) body.destroy();
  });
  body.once('error', (error) => {
    if (!res.headersSent) res.status(500).end();
    else res.destroy(error);
  });
  body.pipe(res);
  return res;
}
