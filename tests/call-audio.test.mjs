import assert from 'node:assert/strict';
import test from 'node:test';

import { parseSingleByteRange } from '../lib/call-audio.mjs';
import { selectCallAudioMode } from '../lib/call-bridge.mjs';

test('selects decoded WAV and streaming M4A strategies by extension', () => {
  assert.equal(selectCallAudioMode('/tmp/greeting.wav'), 'decoded-buffer');
  assert.equal(selectCallAudioMode('/tmp/long.M4A'), 'media-element-stream');
  assert.equal(selectCallAudioMode('/tmp/long.mp4'), 'media-element-stream');
  assert.equal(selectCallAudioMode('/tmp/audio.mp3'), 'unsupported');
});

test('parses bounded single byte ranges', () => {
  assert.equal(parseSingleByteRange(null, 100), null);
  assert.deepEqual(parseSingleByteRange('bytes=0-9', 100), { start: 0, end: 9 });
  assert.deepEqual(parseSingleByteRange('bytes=90-', 100), { start: 90, end: 99 });
  assert.deepEqual(parseSingleByteRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepEqual(parseSingleByteRange('bytes=90-200', 100), { start: 90, end: 99 });
});

test('rejects malformed, unsatisfiable, and multi-ranges', () => {
  for (const value of ['bytes=100-101', 'bytes=9-3', 'bytes=-0', 'bytes=0-1,4-5', 'items=0-1']) {
    assert.deepEqual(parseSingleByteRange(value, 100), { invalid: true });
  }
  assert.deepEqual(parseSingleByteRange('bytes=0-1', 0), { invalid: true });
});