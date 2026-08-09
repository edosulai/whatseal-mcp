/** Local TCP surfaces are opt-in. The private Unix control socket is unaffected. */
export function parseLocalHttpPolicy(env = process.env) {
  const webApiEnabled = String(env.WHATSEAL_WEB_API ?? env.WHATSAPP_HTTP_API ?? '0') === '1';
  const callAudioEnabled = String(env.WHATSAPP_CALL_AUDIO_HTTP ?? '0') === '1';
  return {
    webApiEnabled,
    callAudioEnabled,
    listenerEnabled: webApiEnabled || callAudioEnabled,
  };
}

/**
 * Web sends use the same immutable draft + native approval path as MCP sends.
 * The injected dispatch function makes this policy independently testable.
 */
export async function executeApprovedHttpSend(dispatch, { chatId, text } = {}) {
  const target = String(chatId || '').trim();
  const body = String(text || '').trim();
  if (!target || !body) throw new Error('chatId and text required');

  const prepared = await dispatch('prepareSend', { chat: target, text: body });
  const outcome = await dispatch('requestLocalApproval', { approvalId: prepared.approvalId });
  return {
    success: ['sent', 'completed'].includes(outcome?.state),
    approvalId: prepared.approvalId,
    target: prepared.target,
    outcome,
  };
}