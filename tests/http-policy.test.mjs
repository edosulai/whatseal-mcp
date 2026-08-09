import assert from 'node:assert/strict';
import test from 'node:test';

import {
  executeApprovedHttpSend,
  parseLocalHttpPolicy,
} from '../lib/http-policy.mjs';

test('local HTTP listeners are default-off and independently opt-in', () => {
  assert.deepEqual(parseLocalHttpPolicy({}), {
    webApiEnabled: false,
    callAudioEnabled: false,
    listenerEnabled: false,
  });
  assert.equal(parseLocalHttpPolicy({ WHATSEAL_WEB_API: '1' }).webApiEnabled, true);
  assert.equal(parseLocalHttpPolicy({ WHATSAPP_HTTP_API: '1' }).webApiEnabled, true);
  assert.equal(parseLocalHttpPolicy({ WHATSAPP_CALL_AUDIO_HTTP: '1' }).callAudioEnabled, true);
});

test('HTTP send always prepares then requests native approval', async () => {
  const calls = [];
  const dispatch = async (method, params) => {
    calls.push({ method, params });
    if (method === 'prepareSend') {
      return { approvalId: 'approval-1', target: { id: 'chat-1', name: 'Test' } };
    }
    if (method === 'requestLocalApproval') {
      return { state: 'sent', message: { id: 'message-1' } };
    }
    throw new Error(`unexpected method ${method}`);
  };

  const result = await executeApprovedHttpSend(dispatch, { chatId: 'chat-1', text: 'hello' });
  assert.equal(result.success, true);
  assert.equal(result.approvalId, 'approval-1');
  assert.deepEqual(calls, [
    { method: 'prepareSend', params: { chat: 'chat-1', text: 'hello' } },
    { method: 'requestLocalApproval', params: { approvalId: 'approval-1' } },
  ]);
});