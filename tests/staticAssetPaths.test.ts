import assert from 'node:assert/strict';
import { migrateLegacyStaticAssetPaths } from '../server/staticAssetPaths.ts';

const state = {
  characters: [{ referenceImageUrl: '/src/assets/images/character.jpg' }],
  projects: [{ scenes: [{ imageUrl: '/src/assets/images/scene.jpg' }] }],
  external: 'https://example.com/src/assets/images/keep-this.jpg',
  prompt: 'The path /src/assets/images/ is mentioned in documentation.',
};

const migrated = migrateLegacyStaticAssetPaths(state);
assert.equal(migrated, 2);
assert.equal(state.characters[0].referenceImageUrl, '/assets/images/character.jpg');
assert.equal(state.projects[0].scenes[0].imageUrl, '/assets/images/scene.jpg');
assert.equal(state.external, 'https://example.com/src/assets/images/keep-this.jpg');
assert.equal(state.prompt, 'The path /src/assets/images/ is mentioned in documentation.');

console.log('Legacy static asset path migration tests passed.');
