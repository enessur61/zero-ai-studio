import assert from 'node:assert/strict';
import { generateCloudflareText, isCloudflareWorkersAiConfigured } from '../server/cloudflareWorkersAi.ts';

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
    maxTokens: 24,
    fetchImpl: async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return new Response(JSON.stringify({
        success: true,
        result: { response: 'BEREIT' },
        errors: [],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });

  assert.equal(result.text, 'BEREIT');
  assert.equal(result.modelId, '@cf/zai-org/glm-4.7-flash');
  assert.match(requestUrl, /accounts\/account-test\/ai\/run\/@cf%2Fzai-org%2Fglm-4\.7-flash$/);
  assert.equal((requestInit?.headers as Record<string, string>).Authorization, 'Bearer secret-test-token');
  assert.equal(JSON.parse(String(requestInit?.body)).max_tokens, 24);

  await assert.rejects(
    () => generateCloudflareText({
      prompt: 'test',
      fetchImpl: async () => new Response(JSON.stringify({
        success: false,
        errors: [{ message: 'limit exceeded' }],
      }), { status: 429 }),
    }),
    /kein kostenpflichtiger Fallback/,
  );

  console.log('Cloudflare Workers AI adapter tests passed.');
} finally {
  if (originalAccount === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID;
  else process.env.CLOUDFLARE_ACCOUNT_ID = originalAccount;
  if (originalToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
  else process.env.CLOUDFLARE_API_TOKEN = originalToken;
}
