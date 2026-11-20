import { Readable, Transform, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

type VideoStreamTarget = Writable & {
  setHeader(name: string, value: string): unknown;
  statusCode: number;
};

export const WAN_VIDEO_MAX_BYTES = 100 * 1024 * 1024;
export const WAN_VIDEO_MIN_BYTES = 1024;

/** Validate and stream an authenticated worker MP4 without buffering it in RAM. */
export async function streamWanVideoResponse(
  response: globalThis.Response,
  target: VideoStreamTarget,
  maxBytes = WAN_VIDEO_MAX_BYTES,
): Promise<number> {
  const contentType = (response.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'video/mp4') throw new Error('Wan-Worker lieferte keinen MP4-Inhalt.');
  const declaredLength = Number(response.headers.get('content-length'));
  if (!Number.isSafeInteger(declaredLength) || declaredLength < WAN_VIDEO_MIN_BYTES) {
    throw new Error('Wan-Worker lieferte keine gültige MP4-Dateigröße.');
  }
  if (declaredLength > maxBytes) throw new Error('Wan-Video überschreitet das 100-MB-Proxy-Limit.');
  if (!response.body) throw new Error('Wan-Worker lieferte keinen Videostream.');

  target.statusCode = 200;
  target.setHeader('Content-Type', 'video/mp4');
  target.setHeader('Content-Disposition', 'attachment; filename="zero-wan-video.mp4"');
  target.setHeader('Content-Length', String(declaredLength));
  target.setHeader('Cache-Control', 'no-store');
  target.setHeader('X-Content-Type-Options', 'nosniff');
  let transferred = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      transferred += chunk.length;
      if (transferred > maxBytes || transferred > declaredLength) {
        callback(new Error('Wan-Videostream überschreitet die angekündigte Dateigröße.'));
        return;
      }
      callback(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
    limiter,
    target,
  );
  if (transferred !== declaredLength) {
    throw new Error('Wan-Videostream ist unvollständig.');
  }
  return transferred;
}
