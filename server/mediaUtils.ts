export interface ParsedBase64DataUrl {
  mimeType: string;
  data: string;
  byteLength: number;
}

/** Parse and bound an uploaded base64 data URL before forwarding it to a model provider. */
export function parseBase64DataUrl(
  value: string,
  allowedMimeTypes: readonly string[],
  maxBytes: number
): ParsedBase64DataUrl | null {
  const match = value.match(/^data:([^;,]+)(?:;[^,]*)?;base64,([A-Za-z0-9+/]+={0,2})$/i);
  if (!match) return null;

  const mimeType = match[1].toLowerCase();
  if (!allowedMimeTypes.includes(mimeType)) return null;

  const data = match[2];
  const decoded = Buffer.from(data, 'base64');
  const canonical = decoded.toString('base64').replace(/=+$/, '');
  if (!decoded.length || canonical !== data.replace(/=+$/, '')) return null;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || decoded.length > maxBytes) return null;

  return { mimeType, data, byteLength: decoded.length };
}
