import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { streamWanVideoResponse } from '../server/wanVideoStream.ts';

function target() {
  const stream = new PassThrough() as PassThrough & { headers: Record<string, string>; statusCode: number; setHeader(name: string, value: string): void };
  stream.headers = {};
  stream.statusCode = 0;
  stream.setHeader = (name, value) => { stream.headers[name.toLowerCase()] = value; };
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  return { stream, chunks };
}

{
  const payload = new Uint8Array(4096).fill(7);
  const response = new Response(payload, { headers: { 'content-type': 'video/mp4', 'content-length': String(payload.length) } });
  const output = target();
  const size = await streamWanVideoResponse(response, output.stream);
  assert.equal(size, payload.length);
  assert.equal(Buffer.concat(output.chunks).length, payload.length);
  assert.equal(output.stream.headers['content-type'], 'video/mp4');
  assert.equal(output.stream.headers['content-length'], String(payload.length));
  assert.equal(output.stream.statusCode, 200);
}

{
  const response = new Response(new Uint8Array(4096), { headers: { 'content-type': 'text/plain', 'content-length': '4096' } });
  await assert.rejects(() => streamWanVideoResponse(response, target().stream), /keinen MP4-Inhalt/);
}

{
  const response = new Response(new Uint8Array(4096), { headers: { 'content-type': 'video/mp4', 'content-length': '104857601' } });
  await assert.rejects(() => streamWanVideoResponse(response, target().stream), /100-MB-Proxy-Limit/);
}

{
  const response = new Response(new Uint8Array(512), { headers: { 'content-type': 'video/mp4', 'content-length': '512' } });
  await assert.rejects(() => streamWanVideoResponse(response, target().stream), /Dateigröße/);
}


{
  const response = new Response(new Uint8Array(2048), { headers: { 'content-type': 'video/mp4', 'content-length': '4096' } });
  await assert.rejects(() => streamWanVideoResponse(response, target().stream), /unvollständig/);
}

{
  const response = new Response(new Uint8Array(4096), { headers: { 'content-type': 'video/mp4', 'content-length': '2048' } });
  await assert.rejects(() => streamWanVideoResponse(response, target().stream), /überschreitet/);
}

{
  const response = new Response(null, { headers: { 'content-type': 'video/mp4', 'content-length': '4096' } });
  await assert.rejects(() => streamWanVideoResponse(response, target().stream), /keinen Videostream/);
}

console.log('Wan MP4 streaming validation tests passed.');
