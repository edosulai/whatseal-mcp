/**
 * Experimental WhatsApp Web call bridge.
 *
 * Ported (selectively) from unmerged upstream PRs — kept in-process so we do not
 * fork whatsapp-web.js or switch packages:
 *
 * 1) wwebjs #201825 — VoIP stack accept/end + getUserMedia audio graph inject
 *    https://github.com/wwebjs/whatsapp-web.js/pull/201825
 * 2) wwebjs #201881 — experimental call controls / controller resolution patterns
 *    https://github.com/wwebjs/whatsapp-web.js/pull/201881
 * 3) wppconnect-server #2521 — media-bridge ideas (outbound audio replace);
 *    we only take the lightweight inject approach (Web Audio → getUserMedia),
 *    NOT the full Socket.IO PCM bridge.
 *
 * Live WhatsApp Web VoIP facts (from WA Web bundles / wa-diff):
 * - getVoipStackInterface() is lazy; returns null when isVoipDownloadEnabled() is false
 *   (missing SharedArrayBuffer/Atomics/RTCPeerConnection, or enable_web_calling AB prop off).
 * - Real web stack acceptCall(unmute, enableVideo) — NOT acceptCall(callId, isVideo).
 *   UI path: stack.acceptCall(!isMuted, isVideo && !videoMuted).
 * - reject/end require stack.type === 'web' and set activeCall.userEndedCall = true first.
 *
 * Official stable whatsapp-web.js still only exposes Call.reject() (signal stanza).
 * Do NOT reintroduce raw WAWap "accept" stanzas — they dismiss ring UI without media.
 */

export function selectCallAudioMode(filePath) {
  const value = String(filePath || '').trim().toLowerCase();
  if (/\.wav$/.test(value)) return 'decoded-buffer';
  if (/\.(m4a|mp4)$/.test(value)) return 'media-element-stream';
  return 'unsupported';
}

/** Browser-side helpers injected into the WhatsApp Web page (page context). */
export const CALL_BRIDGE_PAGE_SOURCE = String.raw`
(() => {
  const VERSION = 'whatseal-call-bridge-9';
  // Re-install when version changes so live daemons pick up signature fixes.
  if (window.__whatsealCallBridgeInstalled && window.__whatsealCallBridgeVersion === VERSION) {
    return { already: true, version: VERSION };
  }
  if (window.__whatsealCallBridgeInstalled && window.__whatsealCallBridgeVersion !== VERSION) {
    try { window.__whatsealCallBridgeApi?.teardownCallMediaStream?.(); } catch { /* ignore old bridge cleanup */ }
  }

  const store = () => window.__whatsealCallBridge || (window.__whatsealCallBridge = {});

  /**
   * Meta ships enable_web_calling=false for many linked-desktop cohorts.
   * Without it, getVoipStackInterface() returns null and Accept UI never mounts.
   * Wrap ABProps getter so isVoipDownloadEnabled() can pass (SAB/Atomics already OK).
   */
  function forceEnableWebCalling(callId, peerJid) {
    const s = store();
    const target = verifyCallTarget(callId, peerJid);
    if (!target.matches) return { forced: false, error: target.reason, target };
    const ownerKey = callId + '\n' + peerJid;
    if (s._abPropsForced) {
      return s._abPropsOwnerKey === ownerKey
        ? { already: true, ownerKey, ...voipGatingSnapshot() }
        : { forced: false, error: 'voip-gating-owner-mismatch', ownerKey: s._abPropsOwnerKey };
    }
    try {
      const ab = window.require('WAWebABProps');
      if (ab && typeof ab.getABPropConfigValue === 'function' && !ab._whatsealForcedCalling) {
        if (ab.getABPropConfigValue('enable_web_calling') === true) {
          return { already: true, nativeEnabled: true, ownerKey, ...voipGatingSnapshot() };
        }
        // Only wrap the public getter. Do NOT call setGetABPropConfigValueImpl with a
        // function that re-enters getABPropConfigValue — that recurses forever because
        // the public getter always delegates to the private impl slot.
        const original = ab.getABPropConfigValue;
        ab._whatsealForcedCalling = true;
        ab.getABPropConfigValue = (name) => {
          if (name === 'enable_web_calling') return true;
          return original.call(ab, name);
        };
        s._abPropsForced = true;
        s._abPropsOwnerKey = ownerKey;
        s._abPropsModule = ab;
        s._abPropsOriginal = original;
      }
    } catch (error) {
      return { already: false, error: error.message, ...voipGatingSnapshot() };
    }
    if (!s._abPropsForced) {
      return { already: false, forced: false, error: 'voip-gating-override-unavailable', ownerKey };
    }
    return { already: false, forced: true, ownerKey, ...voipGatingSnapshot() };
  }

  function restoreWebCalling() {
    const s = store();
    const ab = s._abPropsModule;
    if (ab && s._abPropsOriginal) {
      try { ab.getABPropConfigValue = s._abPropsOriginal; } catch { /* ignore restore errors */ }
      try { delete ab._whatsealForcedCalling; } catch { ab._whatsealForcedCalling = false; }
    }
    const restored = Boolean(s._abPropsForced);
    s._abPropsForced = false;
    s._abPropsOwnerKey = null;
    s._abPropsModule = null;
    s._abPropsOriginal = null;
    return { restored };
  }

  async function ensureVoipInited(callId, peerJid) {
    const s = store();
    const initialTarget = verifyCallTarget(callId, peerJid);
    if (!initialTarget.matches) return { ok: false, error: initialTarget.reason, target: initialTarget };
    try {
      const initMod = window.require('WAWebVoipInit');
      let inited = false;
      let emitterKeys = null;
      try {
        const emitter = initMod?.VoipInitEventEmitter || window.require('WAWebVoipInitEventEmitter')?.VoipInitEventEmitter;
        inited = Boolean(emitter?.getIsVoipInited?.());
        emitterKeys = emitter ? Object.keys(emitter).slice(0, 20) : null;
        if (inited) {
          s._voipInitOk = true;
          return { ok: true, already: true, inited: true };
        }
      } catch { /* ignore */ }

      // Official export from WAWebVoipInit: initWAWebVoip(reason)
      const candidates = [];
      if (typeof initMod?.initWAWebVoip === 'function') candidates.push(['initWAWebVoip', initMod.initWAWebVoip.bind(initMod)]);
      if (typeof initMod?.retryWAWebVoipInitAfterFailure === 'function') candidates.push(['retryWAWebVoipInitAfterFailure', initMod.retryWAWebVoipInitAfterFailure.bind(initMod)]);
      if (typeof initMod?.init === 'function') candidates.push(['init', initMod.init.bind(initMod)]);

      const tried = [];
      for (const [name, fn] of candidates) {
        try {
          const target = verifyCallTarget(callId, peerJid);
          if (!target.matches) return { ok: false, error: target.reason, target, tried };
          await fn('whatseal');
          tried.push({ name, ok: true });
        } catch (error) {
          tried.push({ name, ok: false, error: error.message });
        }
      }

      // Wait briefly for async stack init.
      for (let i = 0; i < 20; i += 1) {
        try {
          const target = verifyCallTarget(callId, peerJid);
          if (!target.matches) return { ok: false, error: target.reason, target, tried };
          const emitter = initMod?.VoipInitEventEmitter || window.require('WAWebVoipInitEventEmitter')?.VoipInitEventEmitter;
          if (emitter?.getIsVoipInited?.()) {
            s._voipInitOk = true;
            return { ok: true, already: false, inited: true, tried, waitMs: i * 200 };
          }
        } catch { /* ignore */ }
        await new Promise((r) => setTimeout(r, 200));
      }

      let after = false;
      try {
        const emitter = initMod?.VoipInitEventEmitter || window.require('WAWebVoipInitEventEmitter')?.VoipInitEventEmitter;
        after = Boolean(emitter?.getIsVoipInited?.());
      } catch { /* ignore */ }
      s._voipInitOk = after;
      return {
        ok: after,
        already: false,
        inited: after,
        tried,
        emitterKeys,
        keys: Object.keys(initMod || {}).slice(0, 20),
      };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  function describeValue(value, depth = 0) {

    if (value == null) return { type: String(value) };
    const t = typeof value;
    if (t !== 'object') return { type: t };
    if (depth > 1) return { type: 'object', shallow: true };
    const keys = [];
    try {
      keys.push(...Object.keys(value));
    } catch { /* ignore */ }
    let protoFns = [];
    try {
      const proto = Object.getPrototypeOf(value);
      if (proto) {
        protoFns = Object.getOwnPropertyNames(proto)
          .filter((k) => k !== 'constructor' && typeof value[k] === 'function')
          .slice(0, 40);
      }
    } catch { /* ignore */ }
    const ownFns = keys.filter((k) => {
      try { return typeof value[k] === 'function'; } catch { return false; }
    }).slice(0, 40);
    return {
      type: t,
      ctor: value.constructor?.name || null,
      keys: keys.slice(0, 40),
      ownFns,
      protoFns,
      stackType: value.type || null,
      hasAccept: typeof value.acceptCall === 'function',
      hasReject: typeof value.rejectCall === 'function',
      hasEnd: typeof value.endCall === 'function',
    };
  }

  function voipGatingSnapshot() {
    const snap = {
      sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
      atomics: typeof Atomics !== 'undefined',
      rtcPeerConnection: typeof RTCPeerConnection !== 'undefined',
      crossOriginIsolated: typeof crossOriginIsolated === 'boolean' ? crossOriginIsolated : null,
      isSecureContext: typeof isSecureContext === 'boolean' ? isSecureContext : null,
      enableWebCalling: null,
      isVoipDownloadEnabled: null,
      isWebCallingUiEnabled: null,
      gatingError: null,
    };
    try {
      const ab = window.require('WAWebABProps');
      if (ab && typeof ab.getABPropConfigValue === 'function') {
        snap.enableWebCalling = ab.getABPropConfigValue('enable_web_calling');
      }
    } catch (error) {
      snap.gatingError = (snap.gatingError || '') + 'ABProps:' + error.message + ';';
    }
    try {
      const gate = window.require('WAWebVoipGatingUtils');
      if (gate) {
        if (typeof gate.isVoipDownloadEnabled === 'function') {
          snap.isVoipDownloadEnabled = gate.isVoipDownloadEnabled();
        }
        if (typeof gate.isWebCallingUiEnabled === 'function') {
          snap.isWebCallingUiEnabled = gate.isWebCallingUiEnabled();
        }
      }
    } catch (error) {
      snap.gatingError = (snap.gatingError || '') + 'Gating:' + error.message + ';';
    }
    return snap;
  }

  async function resolveVoipStack() {
    const attempts = [];
    const gating = voipGatingSnapshot();

    const tryGetter = async (label, fn) => {
      try {
        const iface = await fn();
        const desc = describeValue(iface);
        attempts.push({ name: label, result: desc });
        if (
          iface &&
          (typeof iface.acceptCall === 'function' ||
            typeof iface.endCall === 'function' ||
            typeof iface.rejectCall === 'function')
        ) {
          return { iface, via: label, desc };
        }
        return null;
      } catch (error) {
        attempts.push({ name: label, error: error.message });
        return null;
      }
    };

    // Primary: WAWebVoipStackInterface.getVoipStackInterface()
    // May return null when VoIP download is gated (no SAB / enable_web_calling false).
    let hit = await tryGetter('WAWebVoipStackInterface.getVoipStackInterface', async () => {
      const mod = window.require('WAWebVoipStackInterface');
      if (!mod) return null;
      if (typeof mod.getVoipStackInterface === 'function') {
        const first = await mod.getVoipStackInterface();
        if (first) return first;
        // Lazy bundle can race; retry once after a short wait.
        await new Promise((r) => setTimeout(r, 400));
        return mod.getVoipStackInterface();
      }
      if (mod.default && typeof mod.default.getVoipStackInterface === 'function') {
        return mod.default.getVoipStackInterface();
      }
      return mod;
    });
    if (hit) return { ...hit, attempts, gating };

    // Alternate module name seen on some builds (often empty export object).
    hit = await tryGetter('WAWebVoipCallStackInterface', async () => {
      const mod = window.require('WAWebVoipCallStackInterface');
      if (!mod) return null;
      if (typeof mod.getCallStackInterface === 'function') return mod.getCallStackInterface();
      if (typeof mod.getVoipStackInterface === 'function') return mod.getVoipStackInterface();
      if (mod.default) {
        if (typeof mod.default.getCallStackInterface === 'function') return mod.default.getCallStackInterface();
        if (typeof mod.default.getVoipStackInterface === 'function') return mod.default.getVoipStackInterface();
      }
      return mod;
    });
    if (hit) return { ...hit, attempts, gating };

    // Some builds expose Impl factory after the lazy chunk is already loaded.
    hit = await tryGetter('WAWebVoipStackInterfaceImpl', async () => {
      const mod = window.require('WAWebVoipStackInterfaceImpl');
      if (!mod) return null;
      if (typeof mod.getVoipStackInterfaceImpl === 'function') return mod.getVoipStackInterfaceImpl();
      if (typeof mod.createWAWebVoipStackInterface === 'function') return mod.createWAWebVoipStackInterface();
      return mod;
    });
    if (hit) return { ...hit, attempts, gating };

    return { iface: null, via: null, attempts, gating };
  }

  function restoreGetUserMediaInject() {
    const s = store();
    let wa = false;
    let navigator = false;
    try {
      if (s._gumWaModule && s._gumWaOriginal) {
        s._gumWaModule.getUserMedia = s._gumWaOriginal;
        try { delete s._gumWaModule._whatsealPatched; } catch { s._gumWaModule._whatsealPatched = false; }
        wa = true;
      }
    } catch { /* ignore restore errors */ }
    try {
      if (s._gumMediaDevices && s._gumNavigatorOriginal) {
        s._gumMediaDevices.getUserMedia = s._gumNavigatorOriginal;
        try { delete s._gumMediaDevices._whatsealPatched; } catch { s._gumMediaDevices._whatsealPatched = false; }
        navigator = true;
      }
    } catch { /* ignore restore errors */ }
    s._gumInjectInstalled = false;
    s._gumOwnerKey = null;
    s._gumInject = null;
    s._gumWaModule = null;
    s._gumWaOriginal = null;
    s._gumMediaDevices = null;
    s._gumNavigatorOriginal = null;
    return { restored: wa || navigator, wa, navigator };
  }

  function installGetUserMediaInject(callId, peerJid) {
    const s = store();
    const target = verifyCallTarget(callId, peerJid);
    if (!target.matches) return { wa: false, navigator: false, errors: [target.reason], target };
    const ownerKey = callId + '\n' + peerJid;
    if (s._gumInjectInstalled) {
      if (s._gumOwnerKey === ownerKey) return s._gumInject;
      restoreGetUserMediaInject();
    }
    const report = { wa: false, navigator: false, errors: [], ownerKey };

    const makeInjectedStream = (constraints, originalFn) => {
      const media = store()._callMedia;
      const active = store()._callMediaActive;
      const currentOwner = store()._gumOwnerKey;
      const wantsAudio = !constraints || constraints.audio !== false;
      const wantsVideo = Boolean(constraints && constraints.video);
      const ownedTarget = currentOwner === ownerKey && verifyCallTarget(callId, peerJid).matches;
      // Only replace pure-audio mic capture owned by this exact active call.
      if (!active || !media || media.ownerKey !== ownerKey || !ownedTarget || !wantsAudio || wantsVideo) {
        return originalFn(constraints);
      }
      const destination = media.context.createMediaStreamDestination();
      try { media.master.connect(destination); } catch { /* already connected */ }
      media.destinations.push(destination);
      // Keep a silent/keep-alive tone path optional: gain is 1; greeting connects later.
      return Promise.resolve(destination.stream);
    };

    try {
      const mediaModule = window.require('WAGetUserMedia');
      if (mediaModule && typeof mediaModule.getUserMedia === 'function' && !mediaModule._whatsealPatched) {
        const original = mediaModule.getUserMedia;
        s._gumWaModule = mediaModule;
        s._gumWaOriginal = original;
        mediaModule._whatsealPatched = true;
        mediaModule.getUserMedia = (constraints) => makeInjectedStream(
          constraints,
          (next) => original.call(mediaModule, next),
        );
        report.wa = true;
      }
    } catch (error) {
      report.errors.push('WAGetUserMedia:' + error.message);
    }

    try {
      const md = navigator.mediaDevices;
      if (md && typeof md.getUserMedia === 'function' && !md._whatsealPatched) {
        const original = md.getUserMedia;
        s._gumMediaDevices = md;
        s._gumNavigatorOriginal = original;
        md._whatsealPatched = true;
        md.getUserMedia = (constraints) => makeInjectedStream(
          constraints,
          (next) => original.call(md, next),
        );
        report.navigator = true;
      }
    } catch (error) {
      report.errors.push('navigator:' + error.message);
    }

    if (!report.wa || !report.navigator || report.errors.length > 0) {
      restoreGetUserMediaInject();
      return { ...report, installed: false };
    }
    s._gumInjectInstalled = true;
    s._gumOwnerKey = ownerKey;
    s._gumInject = { ...report, installed: true };
    return s._gumInject;
  }

  function setupCallMediaStream(callId, peerJid) {
    const s = store();
    const target = verifyCallTarget(callId, peerJid);
    if (!target.matches) throw new Error(target.reason);
    const ownerKey = callId + '\n' + peerJid;
    if (s._callMedia && s._callMedia.context && s._callMedia.context.state !== 'closed') {
      if (s._callMedia.ownerKey !== ownerKey) teardownCallMediaStream();
      else {
        s._callMediaActive = true;
        const gum = installGetUserMediaInject(callId, peerJid);
        if (!gum.installed) throw new Error('get-user-media-inject-unavailable:' + gum.errors.join('|'));
        return s._callMedia;
      }
    }

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    const context = new AudioContextClass();
    const master = context.createGain();
    master.gain.value = 1.0;
    // subtle silent keep-alive so track stays "live" before greeting starts
    const silence = context.createConstantSource();
    silence.offset.value = 0;
    const silenceGain = context.createGain();
    silenceGain.gain.value = 0.0001;
    silence.connect(silenceGain);
    silenceGain.connect(master);
    try { silence.start(); } catch { /* ignore */ }
    s._callMediaGeneration = Number(s._callMediaGeneration || 0) + 1;
    s._callMedia = {
      generation: s._callMediaGeneration,
      ownerKey,
      context,
      master,
      destinations: [],
      silence,
      silenceGain,
      sources: [],
    };
    s._callMediaActive = true;
    s._callMedia.gum = installGetUserMediaInject(callId, peerJid);
    if (!s._callMedia.gum.installed) {
      throw new Error('get-user-media-inject-unavailable:' + s._callMedia.gum.errors.join('|'));
    }
    return s._callMedia;
  }

  function cleanupCallAudioPlayback(reason = 'cleanup') {
    const s = store();
    const media = s._callMedia;
    const playback = media?.mediaElementPlayback || null;
    if (playback) {
      try { playback.element.pause(); } catch { /* ignore */ }
      try { playback.source.disconnect(); } catch { /* ignore */ }
      try {
        playback.element.removeAttribute('src');
        playback.element.load();
      } catch { /* ignore */ }
      if (playback.objectUrl) {
        try { URL.revokeObjectURL(playback.objectUrl); } catch { /* ignore */ }
      }
      media.mediaElementPlayback = null;
    }
    if (s._callAudioState) {
      const terminal = ['ended', 'error', 'stopped'].includes(s._callAudioState.status);
      s._callAudioState = {
        ...s._callAudioState,
        status: terminal || ['ended', 'error', 'replaced'].includes(reason)
          ? s._callAudioState.status
          : 'stopped',
        ...(!terminal && !['ended', 'error', 'replaced'].includes(reason) ? { stoppedAt: Date.now() } : {}),
        cleanedAt: Date.now(),
        cleanupReason: reason,
      };
    }
    return { cleaned: Boolean(playback), reason, state: s._callAudioState || null };
  }

  function teardownCallMediaStream() {
    const s = store();
    const media = s._callMedia;
    s._callMediaActive = false;
    s._callMediaGeneration = Number(s._callMediaGeneration || 0) + 1;
    const gum = restoreGetUserMediaInject();
    const calling = restoreWebCalling();
    if (!media) return { tornDown: false, calling, gum };
    cleanupCallAudioPlayback('call-teardown');
    for (const source of media.sources || []) {
      try { source.stop(); } catch { /* ignore */ }
      try { source.disconnect(); } catch { /* ignore */ }
    }
    media.sources = [];
    for (const destination of media.destinations || []) {
      try { media.master.disconnect(destination); } catch { /* already disconnected */ }
      for (const track of destination.stream?.getTracks?.() || []) {
        try { track.stop(); } catch { /* ignore */ }
      }
    }
    media.destinations = [];
    try { media.silence.stop(); } catch { /* ignore */ }
    try { media.silence.disconnect(); } catch { /* ignore */ }
    try { media.silenceGain.disconnect(); } catch { /* ignore */ }
    try { media.master.disconnect(); } catch { /* ignore */ }
    try { void media.context.close(); } catch { /* ignore */ }
    s._callMedia = null;
    return { tornDown: true, calling, gum };
  }

  async function playCallAudioBase64(base64, { loop = false, callId = null, peerJid = null } = {}) {
    const target = verifyCallTarget(callId, peerJid);
    if (!target.matches) return { success: false, error: target.reason, target };
    const media = setupCallMediaStream(callId, peerJid);
    const { context, master } = media;
    const mediaGeneration = media.generation;
    const mediaIsCurrent = () => store()._callMedia === media
      && store()._callMediaGeneration === mediaGeneration
      && verifyCallTarget(callId, peerJid).matches;
    if (context.state === 'suspended') {
      try { await context.resume(); } catch (error) {
        return { success: false, error: 'audio-context-resume:' + error.message };
      }
    }
    if (!mediaIsCurrent()) return { success: false, error: 'call-media-generation-changed' };
    if (!base64 || typeof base64 !== 'string') {
      return { success: false, error: 'empty-audio-base64' };
    }
    // Support raw base64 or data-URL.
    const raw = base64.includes(',') ? base64.split(',').pop() : base64;
    let bytes;
    try {
      const binary = atob(raw);
      bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    } catch (error) {
      return { success: false, error: 'base64-decode:' + error.message };
    }
    let buffer;
    try {
      buffer = await context.decodeAudioData(bytes.buffer.slice(0));
    } catch (error) {
      return { success: false, error: 'decodeAudioData:' + error.message, byteLength: bytes.length };
    }
    if (!mediaIsCurrent()) return { success: false, error: 'call-media-generation-changed' };
    // Stop previous greeting sources so we don't stack audio.
    for (const prev of media.sources || []) {
      try { prev.stop(); } catch { /* ignore */ }
      try { prev.disconnect(); } catch { /* ignore */ }
    }
    media.sources = [];
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = Boolean(loop);
    source.connect(master);
    media.sources.push(source);
    // Ensure at least one destination exists (some WA builds acquire mic before accept).
    if (!media.destinations.length) {
      const destination = context.createMediaStreamDestination();
      master.connect(destination);
      media.destinations.push(destination);
    }
    const startedAt = Date.now();
    return await new Promise((resolve) => {
      source.onended = () => resolve({
        success: true,
        durationSec: buffer.duration,
        durationMs: Math.round(buffer.duration * 1000),
        loop: Boolean(loop),
        destinations: media.destinations.length,
        contextState: context.state,
        gum: media.gum || store()._gumInject || null,
        elapsedMs: Date.now() - startedAt,
      });
      try {
        const current = verifyCallTarget(callId, peerJid);
        if (!current.matches) {
          teardownCallMediaStream();
          resolve({ success: false, error: current.reason, target: current });
          return;
        }
        source.start(0);
      } catch (error) {
        resolve({ success: false, error: 'source.start:' + error.message });
        return;
      }
      if (loop) {
        resolve({
          success: true,
          durationSec: buffer.duration,
          durationMs: Math.round(buffer.duration * 1000),
          loop: true,
          destinations: media.destinations.length,
          contextState: context.state,
          gum: media.gum || store()._gumInject || null,
          started: true,
        });
      }
    });
  }

  function getCallAudioPlaybackState() {
    const s = store();
    const state = s._callAudioState || null;
    if (!state) return null;
    const element = s._callMedia?.mediaElementPlayback?.element || null;
    return {
      ...state,
      currentTimeSec: element ? Number(element.currentTime || 0) : Number(state.currentTimeSec || 0),
      durationSec: element && Number.isFinite(element.duration)
        ? Number(element.duration)
        : (state.durationSec ?? null),
      paused: element ? Boolean(element.paused) : true,
      ended: element ? Boolean(element.ended) : state.status === 'ended',
    };
  }

  async function playCallAudioUrl(url, { callId = null, peerJid = null } = {}) {
    const target = verifyCallTarget(callId, peerJid);
    if (!target.matches) return { success: false, error: target.reason, target };
    let parsed;
    try {
      parsed = new URL(String(url || ''));
    } catch (error) {
      return { success: false, error: 'invalid-audio-url:' + error.message };
    }
    if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname)) {
      return { success: false, error: 'audio-url-must-use-loopback-http' };
    }

    const media = setupCallMediaStream(callId, peerJid);
    const { context, master } = media;
    const mediaGeneration = media.generation;
    const mediaIsCurrent = () => store()._callMedia === media
      && store()._callMediaGeneration === mediaGeneration
      && verifyCallTarget(callId, peerJid).matches;
    cleanupCallAudioPlayback('replaced');
    if (context.state === 'suspended') {
      try { await context.resume(); } catch (error) {
        return { success: false, error: 'audio-context-resume:' + error.message };
      }
    }
    if (!mediaIsCurrent()) return { success: false, error: 'call-media-generation-changed' };

    const element = new Audio();
    element.preload = 'auto';
    element.autoplay = false;
    element.playsInline = true;
    element.crossOrigin = 'anonymous';
    const source = context.createMediaElementSource(element);
    source.connect(master);
    if (!media.destinations.length) {
      const destination = context.createMediaStreamDestination();
      master.connect(destination);
      media.destinations.push(destination);
    }

    const startedAt = Date.now();
    const state = {
      mode: 'media-element-stream',
      status: 'loading',
      callId,
      startedAt,
      durationSec: null,
      currentTimeSec: 0,
      error: null,
    };
    store()._callAudioState = state;
    media.mediaElementPlayback = { element, source, objectUrl: null, callId };

    element.addEventListener('loadedmetadata', () => {
      if (store()._callAudioState !== state) return;
      state.durationSec = Number.isFinite(element.duration) ? Number(element.duration) : null;
      state.status = 'ready';
    });
    element.addEventListener('playing', () => {
      if (store()._callAudioState !== state) return;
      state.status = 'playing';
      state.playingAt = Date.now();
    });
    element.addEventListener('ended', () => {
      if (store()._callAudioState !== state) return;
      state.status = 'ended';
      state.endedAt = Date.now();
      state.currentTimeSec = Number(element.currentTime || 0);
      cleanupCallAudioPlayback('ended');
    });
    element.addEventListener('error', () => {
      if (store()._callAudioState !== state) return;
      state.status = 'error';
      state.error = element.error
        ? 'media-error-' + element.error.code + ':' + (element.error.message || '')
        : 'media-element-error';
      state.failedAt = Date.now();
      cleanupCallAudioPlayback('error');
    });

    element.src = parsed.href;
    try {
      const current = verifyCallTarget(callId, peerJid);
      if (!current.matches) {
        cleanupCallAudioPlayback('call-target-changed');
        return { success: false, error: current.reason, target: current };
      }
      await element.play();
      if (!mediaIsCurrent()) {
        try { element.pause(); } catch { /* ignore */ }
        return { success: false, error: 'call-media-generation-changed' };
      }
    } catch (error) {
      state.status = 'error';
      state.error = 'element.play:' + error.message;
      state.failedAt = Date.now();
      cleanupCallAudioPlayback('play-rejected');
      return { success: false, error: state.error, state: getCallAudioPlaybackState() };
    }
    return {
      success: true,
      started: true,
      mode: state.mode,
      callId,
      durationSec: Number.isFinite(element.duration) ? Number(element.duration) : null,
      destinations: media.destinations.length,
      contextState: context.state,
      gum: media.gum || store()._gumInject || null,
      state: getCallAudioPlaybackState(),
    };
  }

  function getCallCollection() {
    try {
      const mod = window.require('WAWebCallCollection');
      return mod?.get?.() || mod || null;
    } catch {
      return null;
    }
  }

  function getOngoingCall() {
    try {
      const collection = getCallCollection();
      const call = collection?.activeCall || null;
      if (!call) return null;
      const state = typeof call.getState === 'function' ? call.getState() : call.state;
      if (state === 0) return null;
      return call;
    } catch {
      return null;
    }
  }

  function callSnapshot(call) {
    if (!call) return null;
    return {
      id: call.id || null,
      peerJid: call.peerJid?._serialized || call.peerJid || null,
      isVideo: Boolean(call.isVideo),
      isGroup: Boolean(call.isGroup),
      outgoing: Boolean(call.outgoing),
      canHandleLocally: call.canHandleLocally,
      webClientShouldHandle: call.webClientShouldHandle,
      state: typeof call.getState === 'function' ? call.getState() : (call.state ?? null),
    };
  }

  function verifyCallTarget(callId, peerJid = null) {
    const expectedId = typeof callId === 'string' ? callId : '';
    const expectedPeer = peerJid?._serialized || peerJid || null;
    const active = getOngoingCall();
    const actualId = typeof active?.id === 'string' ? active.id : '';
    const actualPeer = active?.peerJid?._serialized || active?.peerJid || null;
    if (!expectedId) return { matches: false, reason: 'missing-expected-call-id', actualId, actualPeer };
    if (!expectedPeer) return { matches: false, reason: 'missing-expected-call-peer', expectedId, actualId, actualPeer };
    if (!active) return { matches: false, reason: 'no-active-call', expectedId, expectedPeer, actualId: null, actualPeer: null };
    if (actualId !== expectedId) {
      return { matches: false, reason: 'call-id-mismatch', expectedId, expectedPeer, actualId, actualPeer };
    }
    if (actualPeer !== expectedPeer) {
      return { matches: false, reason: 'call-peer-mismatch', expectedId, expectedPeer, actualId, actualPeer };
    }
    return { matches: true, expectedId, expectedPeer, actualId, actualPeer };
  }

  function connectionState() {
    try {
      const CC = getCallCollection();
      const active = getOngoingCall();
      return {
        isInConnectedCall: Boolean(CC?.isInConnectedCall),
        pendingOfferCount: CC?.pendingOffers ? Object.keys(CC.pendingOffers).length : 0,
        lastActiveCallId: active?.id || null,
        lastActiveCallState: active
          ? (typeof active.getState === 'function' ? active.getState() : active.state)
          : null,
        peerJid: active?.peerJid?._serialized || active?.peerJid || null,
      };
    } catch (error) {
      return { error: error.message, isInConnectedCall: false };
    }
  }

  async function markUserEndedCall(callId, peerJid = null) {
    try {
      const target = verifyCallTarget(callId, peerJid);
      if (!target.matches) return { marked: false, reason: target.reason, target };
      const active = getOngoingCall();
      active.userEndedCall = true;
      return { marked: true, id: active.id || null };
    } catch (error) {
      return { marked: false, error: error.message };
    }
  }

  // Install public API on window for page.evaluate one-liners + debugging.
  window.__whatsealCallBridgeInstall = true;
  window.__whatsealCallBridgeVersion = VERSION;
  window.__whatsealCallBridgeInstalled = true;
  window.__whatsealCallBridgeApi = {
    version: VERSION,
    resolveVoipStack,
    setupCallMediaStream,
    teardownCallMediaStream,
    cleanupCallAudioPlayback,
    playCallAudioBase64,
    playCallAudioUrl,
    getCallAudioPlaybackState,
    installGetUserMediaInject,
    getOngoingCall,
    callSnapshot,
    verifyCallTarget,
    connectionState,
    voipGatingSnapshot,

    /**
     * Accept an incoming call via the real WA Web VoIP stack.
     *
     * Live WA Web API (useWAWebVoipCallHandlers):
     *   stack.acceptCall(!isMuted, isVideo && !videoMuted)
     * i.e. (unmute:boolean, enableVideo:boolean) — NOT (callId, isVideo).
     * PR #201825's callId-first signature is wrong for current WA Web builds.
     */
    async acceptCall(callId, peerJid = null, isVideo = false, injectAudio = true) {
      const initialTarget = verifyCallTarget(callId, peerJid);
      if (!initialTarget.matches) {
        return { success: false, error: initialTarget.reason, target: initialTarget, method: 'voip-stack.acceptCall' };
      }
      const activeCall = getOngoingCall();
      if (activeCall?.outgoing || activeCall?.isGroup || activeCall?.isVideo || isVideo) {
        return {
          success: false,
          error: activeCall?.outgoing ? 'from-self' : (activeCall?.isGroup ? 'group-call' : 'video-call'),
          target: callSnapshot(activeCall),
        };
      }
      const calling = forceEnableWebCalling(callId, peerJid);
      if (!calling.forced && !calling.already) {
        return { success: false, error: calling.error || 'voip-gating-not-enabled', calling };
      }
      const voipInit = await ensureVoipInited(callId, peerJid);
      if (!voipInit.ok) {
        teardownCallMediaStream();
        return { success: false, error: voipInit.error || 'voip-init-failed', voipInit };
      }
      const postInitTarget = verifyCallTarget(callId, peerJid);
      if (!postInitTarget.matches) {
        teardownCallMediaStream();
        return { success: false, error: postInitTarget.reason, target: postInitTarget };
      }
      const failAccept = (result) => {
        teardownCallMediaStream();
        return result;
      };
      if (injectAudio) {
        try {
          setupCallMediaStream(callId, peerJid);
        } catch (error) {
          return failAccept({ success: false, error: 'call-media-setup:' + error.message });
        }
      }

      // Prefer media-permission path when available (UI does this before accept).
      let mediaPerm = null;
      try {
        const target = verifyCallTarget(callId, peerJid);
        if (!target.matches) return failAccept({ success: false, error: target.reason, target });
        const acquire = injectAudio ? window.require('WAWebVoipAcquireMediaStream') : null;
        if (acquire && typeof acquire.checkVoipDevicePermissions === 'function') {
          mediaPerm = await acquire.checkVoipDevicePermissions(Boolean(isVideo));
          if (mediaPerm === false || mediaPerm?.granted === false || mediaPerm?.error) {
            return failAccept({ success: false, error: 'voip-media-permission-denied', mediaPerm });
          }
        } else if (injectAudio) {
          return failAccept({ success: false, error: 'voip-media-permission-preflight-unavailable' });
        } else if (!injectAudio) {
          mediaPerm = { skipped: true, reason: 'muted-accept-no-media-permission-preflight' };
        }
      } catch (error) {
        return failAccept({ success: false, error: 'voip-media-permission-preflight:' + error.message });
      }

      const { iface, via, attempts, gating } = await resolveVoipStack();
      if (!iface || typeof iface.acceptCall !== 'function') {
        return failAccept({
          success: false,
          error: 'voip-stack.acceptCall unavailable',
          via,
          attempts,
          gating,
          mediaPerm,
          voipInit,
          modulesTried: (attempts || []).map((a) => a.name),
          hint:
            gating && gating.isVoipDownloadEnabled === false
              ? 'VoIP download gated (SharedArrayBuffer/Atomics/RTC or enable_web_calling).'
              : gating && gating.sharedArrayBuffer === false
                ? 'SharedArrayBuffer missing — Chrome needs COOP/COEP isolation for WA VoIP WASM.'
                : 'getVoipStackInterface returned null/non-function-bearing object.',
        });
      }

      // Real signature: acceptCall(unmute, enableVideo)
      const unmute = Boolean(injectAudio);
      const enableVideo = Boolean(isVideo);
      const errors = [];

      try {
        const target = verifyCallTarget(callId, peerJid);
        if (!target.matches) return failAccept({ success: false, error: target.reason, target, method: 'voip-stack.acceptCall' });
        await iface.acceptCall(unmute, enableVideo);
        const callingRestored = restoreWebCalling();
        return {
          success: true,
          method: 'voip-stack.acceptCall(unmute,enableVideo)',
          via,
          callId: callId || null,
          isVideo: enableVideo,
          stackType: iface.type || null,
          mediaPerm,
          voipInit,
          callingRestored,
        };
      } catch (error) {
        errors.push({ sig: '(unmute,enableVideo)', error: error.message });
      }

      // Legacy signatures cannot guarantee muted acceptance. Only try them when
      // a guarded injected mic is active; inject=false must fail closed.
      const legacyAcceptSignatures = injectAudio ? [
        ['(enableVideo)', [enableVideo]],
        ['()', []],
        ['(callId,isVideo)', [callId, enableVideo]],
      ] : [];
      for (const [sig, args] of legacyAcceptSignatures) {
        try {
          const target = verifyCallTarget(callId, peerJid);
          if (!target.matches) return failAccept({ success: false, error: target.reason, target, method: 'voip-stack.acceptCall' });
          await iface.acceptCall(...args);
          const callingRestored = restoreWebCalling();
          return {
            success: true,
            method: 'voip-stack.acceptCall' + sig,
            via,
            callId: callId || null,
            isVideo: enableVideo,
            stackType: iface.type || null,
            mediaPerm,
            callingRestored,
          };
        } catch (error) {
          errors.push({ sig, error: error.message });
        }
      }

      return failAccept({
        success: false,
        error: errors.map((e) => e.sig + ':' + e.error).join(' | '),
        via,
        method: 'voip-stack.acceptCall',
        attempts,
        gating,
        mediaPerm,
        errors,
      });
    },

    async endCall(callId, peerJid = null) {
      const target = verifyCallTarget(callId, peerJid);
      if (!target.matches) return { success: false, error: target.reason, target };
      const { iface, via, attempts, gating } = await resolveVoipStack();
      const marked = await markUserEndedCall(callId, peerJid);
      if (!marked.marked) return { success: false, error: marked.reason || marked.error || 'call-not-marked', marked, via };

      if (iface && typeof iface.endCall === 'function') {
        // PR #201881 / live WA: endCall(EndCallReason.Self, true)
        try {
          let reason = undefined;
          try {
            reason = window.require('WAWebVoipSignalingEnums')?.EndCallReason?.Self;
          } catch { /* optional */ }
          if (reason === undefined) {
            try {
              reason = window.require('WAWebWamEnumCallTermReason')?.CALL_TERM_REASON?.ENDED_BY_USER;
            } catch { /* optional */ }
          }
          if (reason !== undefined) {
            try {
              const current = verifyCallTarget(callId, peerJid);
              if (!current.matches) return { success: false, error: current.reason, target: current, via };
              await iface.endCall(reason, true);
              teardownCallMediaStream();
              return { success: true, method: 'voip-stack.endCall(reason,true)', via, reason };
            } catch (error) {
              // PR #201825 form: endCall(callId, reason)
              try {
                const current = verifyCallTarget(callId, peerJid);
                if (!current.matches) return { success: false, error: current.reason, target: current, via };
                await iface.endCall(callId, reason);
                teardownCallMediaStream();
                return { success: true, method: 'voip-stack.endCall(callId,reason)', via, reason };
              } catch (error2) {
                try {
                  const current = verifyCallTarget(callId, peerJid);
                  if (!current.matches) return { success: false, error: current.reason, target: current, via };
                  await iface.endCall();
                  teardownCallMediaStream();
                  return { success: true, method: 'voip-stack.endCall()', via };
                } catch (error3) {
                  return {
                    success: false,
                    error: error3.message || error2.message || error.message,
                    via,
                    attempts,
                    gating,
                  };
                }
              }
            }
          }
          const current = verifyCallTarget(callId, peerJid);
          if (!current.matches) return { success: false, error: current.reason, target: current, via };
          await iface.endCall();
          teardownCallMediaStream();
          return { success: true, method: 'voip-stack.endCall()', via };
        } catch (error) {
          return { success: false, error: error.message, via, attempts, gating };
        }
      }

      // Model fallback
      try {
        const active = getOngoingCall();
        if (active) {
          for (const name of ['end', 'hangup', 'leave', 'cancel']) {
            if (typeof active[name] === 'function') {
              const current = verifyCallTarget(callId, peerJid);
              if (!current.matches) return { success: false, error: current.reason, target: current, via };
              await active[name]();
              teardownCallMediaStream();
              return { success: true, method: 'call-model.' + name };
            }
          }
        }
      } catch (error) {
        return { success: false, error: error.message, via };
      }
      return { success: false, error: 'no endCall path', via, attempts, gating };
    },

    async rejectCall(callId, peerJid = null) {
      // Prefer VoIP reject (PR #201881: userEndedCall + stack.rejectCall()) over WAWap stanza.
      const target = verifyCallTarget(callId, peerJid);
      if (!target.matches) return { success: false, error: target.reason, target };
      const { iface, via, attempts, gating } = await resolveVoipStack();
      const marked = await markUserEndedCall(callId, peerJid);
      if (!marked.marked) return { success: false, error: marked.reason || marked.error || 'call-not-marked', marked, via };

      if (iface && typeof iface.rejectCall === 'function') {
        try {
          const current = verifyCallTarget(callId, peerJid);
          if (!current.matches) return { success: false, error: current.reason, target: current, via };
          await iface.rejectCall();
          teardownCallMediaStream();
          return { success: true, method: 'voip-stack.rejectCall', via, stackType: iface.type || null };
        } catch (error) {
          return { success: false, error: error.message, via, attempts, gating };
        }
      }
      return {
        success: false,
        error: 'voip-stack.rejectCall unavailable',
        via,
        attempts,
        gating,
      };
    },

    forceEnableWebCalling,
    ensureVoipInited,

    probe() {
      const mods = [
        'WAWebVoipStackInterface',
        'WAWebVoipCallStackInterface',
        'WAWebVoipStackInterfaceImpl',
        'WAWebCallCollection',
        'WAGetUserMedia',
        'WAWebVoipStartCall',
        'WAWebWamEnumCallTermReason',
        'WAWebVoipSignalingEnums',
        'WAWebVoipGatingUtils',
        'WAWebVoipAcquireMediaStream',
      ];
      const available = {};
      for (const name of mods) {
        try {
          const mod = window.require(name);
          available[name] = {
            ok: true,
            keys: Object.keys(mod || {}).slice(0, 40),
            proto: mod && mod.prototype ? Object.getOwnPropertyNames(mod.prototype).slice(0, 20) : null,
          };
        } catch (error) {
          available[name] = { ok: false, error: error.message };
        }
      }
      return {
        version: VERSION,
        connection: connectionState(),
        ongoing: callSnapshot(getOngoingCall()),
        mediaActive: Boolean(store()._callMediaActive),
        gating: voipGatingSnapshot(),
        modules: available,
      };
    },

    async deepProbeStack() {
      const resolved = await resolveVoipStack();
      return {
        version: VERSION,
        gating: resolved.gating || voipGatingSnapshot(),
        via: resolved.via,
        iface: describeValue(resolved.iface),
        attempts: resolved.attempts,
        connection: connectionState(),
        ongoing: callSnapshot(getOngoingCall()),
      };
    },
  };

  return { installed: true, version: VERSION, upgraded: true };
})();
`;

export async function installCallBridge(page) {
  if (!page) return { success: false, error: 'no page' };
  // Source is an IIFE string; evaluate it in page context (not as a function body alone).
  return page.evaluate((source) => (0, eval)(source), CALL_BRIDGE_PAGE_SOURCE);
}

export async function probeCallBridge(page) {
  if (!page) return { success: false, error: 'no page' };
  return page.evaluate(() => {
    if (!window.__whatsealCallBridgeApi) return { installed: false };
    return { installed: true, ...window.__whatsealCallBridgeApi.probe() };
  });
}

export async function deepProbeVoipStack(page) {
  if (!page) return { success: false, error: 'no page' };
  await installCallBridge(page);
  return page.evaluate(async () => {
    if (!window.__whatsealCallBridgeApi?.deepProbeStack) {
      return { installed: Boolean(window.__whatsealCallBridgeApi), error: 'deepProbeStack missing' };
    }
    return window.__whatsealCallBridgeApi.deepProbeStack();
  });
}

export async function voipAcceptCall(page, { callId, peerJid = null, isVideo = false, injectAudio = true } = {}) {
  if (!page) return { success: false, error: 'no page' };
  // Ensure bridge is present (idempotent by version).
  await installCallBridge(page);
  return page.evaluate(async (id, peer, video, inject) => {
    return window.__whatsealCallBridgeApi.acceptCall(id, peer, video, inject);
  }, callId, peerJid, Boolean(isVideo), Boolean(injectAudio));
}

export async function verifyBotCallTarget(page, { callId, peerJid = null } = {}) {
  if (!page) return { matches: false, reason: 'no-page' };
  await installCallBridge(page);
  return page.evaluate(
    (id, peer) => window.__whatsealCallBridgeApi.verifyCallTarget(id, peer),
    callId,
    peerJid,
  );
}

export async function voipEndCall(page, { callId, peerJid = null } = {}) {
  if (!page) return { success: false, error: 'no page' };
  await installCallBridge(page);
  return page.evaluate(
    async (id, peer) => window.__whatsealCallBridgeApi.endCall(id, peer),
    callId || null,
    peerJid,
  );
}

export async function voipRejectCall(page, { callId, peerJid = null } = {}) {
  if (!page) return { success: false, error: 'no page' };
  await installCallBridge(page);
  return page.evaluate(
    async (id, peer) => window.__whatsealCallBridgeApi.rejectCall(id, peer),
    callId || null,
    peerJid,
  );
}

export async function playBotAudioBase64(page, base64, { callId = null, peerJid = null } = {}) {
  if (!page) return { success: false, error: 'no page' };
  await installCallBridge(page);
  return page.evaluate(
    async (b64, id, peer) => window.__whatsealCallBridgeApi.playCallAudioBase64(b64, { callId: id, peerJid: peer }),
    base64,
    callId,
    peerJid,
  );
}

export async function playBotAudioUrl(page, url, { callId = null, peerJid = null } = {}) {
  if (!page) return { success: false, error: 'no page' };
  await installCallBridge(page);
  return page.evaluate(
    async (audioUrl, id, peer) => window.__whatsealCallBridgeApi.playCallAudioUrl(audioUrl, { callId: id, peerJid: peer }),
    url,
    callId,
    peerJid,
  );
}

export async function prepareBotCallMedia(page, { callId, peerJid = null } = {}) {
  if (!page) return { success: false, error: 'no-page' };
  await installCallBridge(page);
  return page.evaluate((id, peer) => {
    const target = window.__whatsealCallBridgeApi.verifyCallTarget(id, peer);
    if (!target.matches) return { success: false, error: target.reason, target };
    const media = window.__whatsealCallBridgeApi.setupCallMediaStream(id, peer);
    return {
      success: true,
      target,
      destinations: media.destinations?.length || 0,
      contextState: media.context?.state || null,
    };
  }, callId, peerJid);
}

export async function getBotAudioPlaybackState(page) {
  if (!page) return null;
  await installCallBridge(page);
  return page.evaluate(() => window.__whatsealCallBridgeApi.getCallAudioPlaybackState());
}

export async function waitForBotAudioEnd(page, { timeoutMs = 0, pollMs = 500 } = {}) {
  const requestedTimeout = Number(timeoutMs);
  const deadline = Number.isFinite(requestedTimeout) && requestedTimeout > 0
    ? Date.now() + requestedTimeout
    : Number.POSITIVE_INFINITY;
  let state = null;
  while (Date.now() <= deadline) {
    state = await getBotAudioPlaybackState(page);
    if (!state) return { success: false, error: 'audio-playback-state-missing' };
    if (state.status === 'ended') return { success: true, state };
    if (state.status === 'error') return { success: false, error: state.error || 'audio-playback-error', state };
    if (state.status === 'stopped') return { success: false, error: 'audio-playback-stopped', state };
    await new Promise((resolve) => setTimeout(resolve, Math.max(100, Number(pollMs) || 500)));
  }
  return { success: false, error: 'audio-playback-timeout', state };
}

export async function teardownBotCallMedia(page) {
  if (!page) return { tornDown: false, error: 'no page' };
  await installCallBridge(page);
  return page.evaluate(() => window.__whatsealCallBridgeApi.teardownCallMediaStream());
}

export async function getBridgeConnectionState(page) {
  if (!page) return { error: 'no page', isInConnectedCall: false };
  await installCallBridge(page);
  return page.evaluate(() => window.__whatsealCallBridgeApi.connectionState());
}

/**
 * Ensure newer WA Web call events fire via change:activeCall (PR #201825 listener fix).
 * Safe to call multiple times; does not remove library map hooks.
 */
export async function patchIncomingCallListener(page) {
  if (!page) return { success: false, error: 'no page' };
  return page.evaluate(() => {
    try {
      const WAWebCallCollection = window.require('WAWebCallCollection');
      if (!WAWebCallCollection || typeof WAWebCallCollection.on !== 'function') {
        return { success: false, error: 'WAWebCallCollection.on missing' };
      }
      if (window.__whatsealActiveCallListener) {
        return { success: true, already: true };
      }
      window.__whatsealActiveCallListener = true;
      WAWebCallCollection.on('change:activeCall', (call) => {
        try {
          const previous = window.__whatsealCallBridgeLastCall || null;
          const callPeerJid = call?.peerJid?._serialized || call?.peerJid || null;
          const callKey = call?.id && callPeerJid ? call.id + '\n' + callPeerJid : null;
          const previousKey = previous?.id && previous?.peerJid ? previous.id + '\n' + previous.peerJid : null;
          if (callKey && previousKey && previousKey !== callKey) {
            window.__whatsealCallBridgeApi?.teardownCallMediaStream?.();
            if (window.__whatsealLastEndedCallKey !== previousKey) {
              window.__whatsealLastEndedCallKey = previousKey;
              try { void window.onWhatsealCallEnded?.({ ...previous, reason: 'active-call-replaced' }); } catch { /* ignore */ }
            }
            window.__whatsealCallBridgeLastCall = null;
          }
          const callState = call
            ? (typeof call.getState === 'function' ? call.getState() : call.state)
            : 0;
          if (call && callState !== 0 && callKey && window.__whatsealLastIncomingCallKey !== callKey) {
            window.__whatsealLastIncomingCallKey = callKey;
            window.__whatsealCallBridgeLastCall = {
              id: call.id,
              peerJid: callPeerJid,
            };
            if (typeof window.onIncomingCall === 'function') {
              window.onIncomingCall({
                id: call.id,
                peerJid: call.peerJid,
                isVideo: call.isVideo,
                isGroup: call.isGroup,
                canHandleLocally: call.canHandleLocally,
                outgoing: call.outgoing,
                webClientShouldHandle: call.webClientShouldHandle,
                participants: call.participants,
              });
            }
          }
          if (!call || callState === 0) {
            const ended = window.__whatsealCallBridgeLastCall || null;
            window.__whatsealCallBridgeApi?.teardownCallMediaStream?.();
            const endedKey = ended?.id && ended?.peerJid ? ended.id + '\n' + ended.peerJid : null;
            if (endedKey && window.__whatsealLastEndedCallKey !== endedKey) {
              window.__whatsealLastEndedCallKey = endedKey;
              try { void window.onWhatsealCallEnded?.(ended); } catch { /* ignore callback errors */ }
            }
            window.__whatsealCallBridgeLastCall = null;
          }
        } catch { /* ignore listener errors */ }
      });
      return { success: true, already: false };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
}
