import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decision, pluginHost } from './policy.mjs';
test('child origins cannot collide with a top-level id', () => {
  assert.equal(pluginHost('alpha/menu'), 'alpha--menu');
  assert.throws(() => pluginHost('alpha--menu'));
  assert.throws(() => pluginHost('../alpha'));
});
test('fail closed on missing and opaque initiators and non-network schemes', () => {
  for (const origin of [undefined, 'null', 'https://outside.test']) assert.equal(decision('https://allowed.test', origin, 'allowed.test').cancel, true);
  assert.equal(decision('https://allowed.test/x', 'clover-plugin://alpha', 'allowed.test').cancel, false);
  for (const target of ['https://allowed.test.evil/x', 'https://allowed.test@evil.test', 'https://evil.test', 'file:///tmp/a']) assert.equal(decision(target, 'clover-plugin://alpha', 'allowed.test').cancel, true);
});
test('redirect destinations must be judged again with original initiator', () => {
  assert.equal(decision('http://allowed.test/start', 'clover-plugin://alpha', 'allowed.test').cancel, false);
  assert.equal(decision('http://denied.test/end', 'clover-plugin://alpha', 'allowed.test').cancel, true);
});
