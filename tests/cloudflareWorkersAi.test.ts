import assert from 'node:assert/strict';
import { analyzeCloudflareImage, generateCloudflareImage, generateCloudflareText, isCloudflareWorkersAiConfigured, transcribeCloudflareAudio } from '../server/cloudflareWorkersAi.ts';

const originalAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
const originalToken = process.env.CLOUDFLARE_API_TOKEN;

try {
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  delete process.env.CLOUDFLARE_API_TOKEN;
  assert.equal(isCloudflareWorkersAiConfigured(), false);

  await assert.rejects(
    () => generateCloudflareText({ prompt: 'test' }),
    /nicht konfiguriert/,
  );

  process.env.CLOUDFLARE_ACCOUNT_ID = 'account-test';
  process.env.CLOUDFLARE_API_TOKEN = 'secret-test-token';
  assert.equal(isCloudflareWorkersAiConfigured(), true);

  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const result = await generateCloudflareText({
    prompt: 'Antworte BEREIT',
    systemPrompt: 'Du bist ZERO.',
    maxTokens: 128,
    enableThinking: false,
    costGuard: async () => undefined,
    fetchImpl: async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return new Response(JSON.stringify({
        success: true,
        result: { choices: [{ message: { content: 'BEREIT' } }] },
        errors: [],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });

  assert.equal(result.text, 'BEREIT');
  assert.equal(result.modelId, '@cf/zai-org/glm-4.7-flash');
  assert.match(requestUrl, /accounts\/account-test\/ai\/run\/@cf\/zai-org\/glm-4\.7-flash$/);
  assert.equal((requestInit?.headers as Record<string, string>).Authorization, 'Bearer secret-test-token');
  const requestBody = JSON.parse(String(requestInit?.body));
  assert.equal(requestBody.max_completion_tokens, 128);
  assert.deepEqual(requestBody.chat_template_kwargs, { enable_thinking: false });
  assert.deepEqual(requestBody.messages, [
    { role: 'system', content: 'Du bist ZERO.' },
    { role: 'user', content: 'Antworte BEREIT' },
  ]);

  let imageUrl = '';
  let imageBody = '';
  const image = await generateCloudflareImage({
    prompt: 'Berliner Straße bei Nacht, film still',
    steps: 4,
    costGuard: async () => undefined,
    fetchImpl: async (input, init) => {
      imageUrl = String(input);
      imageBody = String(init?.body);
      return new Response(JSON.stringify({
        success: true,
        result: { image: 'A'.repeat(256) },
        errors: [],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  assert.match(imageUrl, /@cf\/black-forest-labs\/flux-1-schnell$/);
  assert.deepEqual(JSON.parse(imageBody), {
    prompt: 'Berliner Straße bei Nacht, film still',
    steps: 4,
  });
  assert.equal(image.modelId, '@cf/black-forest-labs/flux-1-schnell');
  assert.ok(image.imageDataUrl.startsWith('data:image/jpeg;base64,'));

  let visionUrl = '';
  let visionBody = '';
  const vision = await analyzeCloudflareImage({
    imageDataUrl: 'data:image/png;base64,AAAA',
    question: 'Was ist auf diesem Bild?',
    costGuard: async () => undefined,
    fetchImpl: async (input, init) => {
      visionUrl = String(input);
      visionBody = String(init?.body);
      return new Response(JSON.stringify({
        success: true,
        result: { answer: 'Ein Testbild.' },
        errors: [],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  assert.ok(visionUrl.endsWith('/@cf/moondream/moondream3.1-9B-A2B'));
  assert.deepEqual(JSON.parse(visionBody), {
    task: 'query',
    image: 'data:image/png;base64,AAAA',
    question: 'Was ist auf diesem Bild?',
    reasoning: false,
    max_tokens: 512,
    stream: false,
  });
  assert.equal(vision.modelId, '@cf/moondream/moondream3.1-9B-A2B');
  assert.equal(vision.answer, 'Ein Testbild.');

  let visionRateLimitAttempts = 0;
  await assert.rejects(
    () => analyzeCloudflareImage({
      imageDataUrl: 'data:image/png;base64,AAAA',
      question: 'Test',
      costGuard: async () => undefined,
    fetchImpl: async () => {
        visionRateLimitAttempts += 1;
        return new Response(JSON.stringify({ success: false, errors: [{ message: 'rate limit' }] }), { status: 429 });
      },
    }),
    /kein kostenpflichtiger Fallback/i,
  );
  assert.equal(visionRateLimitAttempts, 1);

  let transcriptionUrl = '';
  let transcriptionBody = '';
  const transcription = await transcribeCloudflareAudio({
    audioBase64: 'UklGRg==',
    language: 'de',
    task: 'transcribe',
    costGuard: async () => undefined,
    fetchImpl: async (input, init) => {
      transcriptionUrl = String(input);
      transcriptionBody = String(init?.body);
      return new Response(JSON.stringify({
        success: true,
        result: {
          text: 'Hallo ZERO.',
          vtt: 'WEBVTT\\n',
          segments: [{ start: 0, end: 1.25, text: 'Hallo ZERO.' }],
        },
        errors: [],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  assert.ok(transcriptionUrl.endsWith('/@cf/openai/whisper-large-v3-turbo'));
  assert.deepEqual(JSON.parse(transcriptionBody), {
    audio: 'UklGRg==',
    task: 'transcribe',
    language: 'de',
  });
  assert.equal(transcription.modelId, '@cf/openai/whisper-large-v3-turbo');
  assert.equal(transcription.text, 'Hallo ZERO.');
  assert.equal(transcription.segments[0]?.start, 0);
  assert.equal(transcription.segments[0]?.end, 1.25);

  let transcriptionTransientAttempts = 0;
  const recoveredTranscription = await transcribeCloudflareAudio({
    audioBase64: 'UklGRg==',
    costGuard: async () => undefined,
    fetchImpl: async () => {
      transcriptionTransientAttempts += 1;
      if (transcriptionTransientAttempts === 1) {
        return new Response(JSON.stringify({ success: false, errors: [{ message: 'Internal server error' }] }), { status: 500 });
      }
      return new Response(JSON.stringify({ success: true, result: { text: 'Erholt', segments: [] }, errors: [] }), { status: 200 });
    },
  });
  assert.equal(transcriptionTransientAttempts, 2);
  assert.equal(recoveredTranscription.text, 'Erholt');

  let transcriptionRateLimitAttempts = 0;
  await assert.rejects(
    () => transcribeCloudflareAudio({
      audioBase64: 'UklGRg==',
      costGuard: async () => undefined,
    fetchImpl: async () => {
        transcriptionRateLimitAttempts += 1;
        return new Response(JSON.stringify({ success: false, errors: [{ message: 'limit exceeded' }] }), { status: 429 });
      },
    }),
    /kein kostenpflichtiger Fallback/i,
  );
  assert.equal(transcriptionRateLimitAttempts, 1);

  let imageTransientAttempts = 0;
  const recoveredImage = await generateCloudflareImage({
    prompt: 'retry test',
    costGuard: async () => undefined,
    fetchImpl: async () => {
      imageTransientAttempts += 1;
      if (imageTransientAttempts === 1) {
        return new Response(JSON.stringify({ success: false, errors: [{ message: 'Internal server error' }] }), { status: 500 });
      }
      return new Response(JSON.stringify({ success: true, result: { image: 'B'.repeat(256) }, errors: [] }), { status: 200 });
    },
  });
  assert.equal(imageTransientAttempts, 2);
  assert.ok(recoveredImage.imageDataUrl.startsWith('data:image/jpeg;base64,'));

  let imageRateLimitAttempts = 0;
  await assert.rejects(
    () => generateCloudflareImage({
      prompt: 'rate limit test',
      costGuard: async () => undefined,
    fetchImpl: async () => {
        imageRateLimitAttempts += 1;
        return new Response(JSON.stringify({ success: false, errors: [{ message: 'limit exceeded' }] }), { status: 429 });
      },
    }),
    /kein kostenpflichtiger Fallback/i,
  );
  assert.equal(imageRateLimitAttempts, 1);

  let transientAttempts = 0;
  const recovered = await generateCloudflareText({
    prompt: 'zweite Nachricht',
    costGuard: async () => undefined,
    fetchImpl: async () => {
      transientAttempts += 1;
      if (transientAttempts < 3) {
        return new Response(JSON.stringify({
          success: false,
          errors: [{ message: 'Internal server error (test-request-id)' }],
        }), { status: 500 });
      }
      return new Response(JSON.stringify({
        success: true,
        result: { response: 'Wiederhergestellt' },
        errors: [],
      }), { status: 200 });
    },
  });
  assert.equal(transientAttempts, 3);
  assert.equal(recovered.text, 'Wiederhergestellt');

  let rateLimitAttempts = 0;
  await assert.rejects(
    () => generateCloudflareText({
      prompt: 'test',
      costGuard: async () => undefined,
    fetchImpl: async () => {
        rateLimitAttempts += 1;
        return new Response(JSON.stringify({
          success: false,
          errors: [{ message: 'limit exceeded' }],
        }), { status: 429 });
      },
    }),
    /keinen kostenpflichtigen Fallback/,
  );
  assert.equal(rateLimitAttempts, 1, '429 rate limits must not be retried');

  console.log('Cloudflare Workers AI adapter tests passed.');
} finally {
  if (originalAccount === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID;
  else process.env.CLOUDFLARE_ACCOUNT_ID = originalAccount;
  if (originalToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
  else process.env.CLOUDFLARE_API_TOKEN = originalToken;
}
