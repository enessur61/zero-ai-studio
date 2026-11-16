import assert from 'node:assert/strict';
import {
  getPersistedWebGPULocalModelIds,
  WEBGPU_LOCAL_MODELS,
} from '../lib/webgpuLocalModel.ts';

const storageKey = 'zero.webgpu.resident-models.v1';
const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
let storedValue: string | null = null;
let shouldThrow = false;

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem(key: string) {
      if (shouldThrow) throw new Error('storage unavailable');
      assert.equal(key, storageKey);
      return storedValue;
    },
  },
});

try {
  const first = WEBGPU_LOCAL_MODELS[0].modelId;
  const second = WEBGPU_LOCAL_MODELS[1].modelId;

  storedValue = JSON.stringify([first, second, first, 'unknown-model', null, 42]);
  assert.deepEqual(getPersistedWebGPULocalModelIds(), [first, second],
    'only supported model IDs should survive, with duplicates removed');

  storedValue = JSON.stringify([]);
  assert.deepEqual(getPersistedWebGPULocalModelIds(), [],
    'an empty persisted list should remain empty');

  storedValue = JSON.stringify({ model: first });
  assert.deepEqual(getPersistedWebGPULocalModelIds(), [],
    'a non-array payload should be ignored');

  storedValue = '{broken json';
  assert.deepEqual(getPersistedWebGPULocalModelIds(), [],
    'malformed JSON should not break model startup');

  storedValue = null;
  assert.deepEqual(getPersistedWebGPULocalModelIds(), [],
    'missing storage should produce an empty model list');

  shouldThrow = true;
  assert.deepEqual(getPersistedWebGPULocalModelIds(), [],
    'storage access failures should not break model startup');

  console.log('WebGPU persisted-state tests passed: allowlist, deduplication and storage failure handling.');
} finally {
  if (originalDescriptor) {
    Object.defineProperty(globalThis, 'localStorage', originalDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, 'localStorage');
  }
}
