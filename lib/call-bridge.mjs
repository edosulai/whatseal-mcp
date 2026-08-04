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

/** Browser-side helpers injected into the WhatsApp Web page (page context). */
export const CALL_BRIDGE_PAGE_SOURCE = String.raw`
(() => {
  const VERSION = 'whatseal-call-bridge-6';
  // Re-install when version changes so live daemons pick up signature fixes.
  if (window.__whatsealCallBridgeInstalled && window.__whatsealCallBridgeVersion === VERSION) {
    return { already: true, version: VERSION };
  }

  const store = () => window.__whatsealCallBridge || (window.__whatsealCallBridge = {});

  /**
   * Meta ships enable_web_calling=false for many linked-desktop cohorts.
   * Without it, getVoipStackInterface() returns null and Accept UI never mounts.
   * Wrap ABProps getter so isVoipDownloadEnabled() can pass (SAB/Atomics already OK).
   */
  function forceEnableWebCalling() {
    const s = store();
    if (s._abPropsForced) return { already: true, ...voipGatingSnapshot() };
    const forced = new Set([
      'enable_web_calling',
      'enable_web_group_calling',
    ]);
    try {
      const ab = window.require('WAWebABProps');
      if (ab && typeof ab.getABPropConfigValue === 'function' && !ab._whatsealForcedCalling) {
        // Only wrap the public getter. Do NOT call setGetABPropConfigValueImpl with a
        // function that re-enters getABPropConfigValue — that recurses forever because
        // the public getter always delegates to the private impl slot.
        const original = ab.getABPropConfigValue.bind(ab);
        ab._whatsealForcedCalling = true;
        ab.getABPropConfigValue = (name) => {
          if (forced.has(name)) return true;
          return original(name);
        };
        s._abPropsForced = true;
      }
    } catch (error) {
      return { already: false, error: error.message, ...voipGatingSnapshot() };
    }
    return { already: false, forced: true, ...voipGatingSnapshot() };
  }

  async function ensureVoipInited() {
    const s = store();
    forceEnableWebCalling();
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
          await fn('whatseal');
          tried.push({ name, ok: true });
        } catch (error) {
          tried.push({ name, ok: false, error: error.message });
        }
      }

      // Wait briefly for async stack init.
      for (let i = 0; i < 20; i += 1) {
        try {
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
    const force = forceEnableWebCalling();
    const gating = { ...voipGatingSnapshot(), force };

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

  function installGetUserMediaInject() {
    const s = store();
    if (s._gumInjectInstalled) return s._gumInject;
    const report = { wa: false, navigator: false, errors: [] };

    const makeInjectedStream = (constraints, originalFn) => {
      const media = store()._callMedia;
      const active = store()._callMediaActive;
      const wantsAudio = !constraints || constraints.audio !== false;
      const wantsVideo = Boolean(constraints && constraints.video);
      // Only replace pure-audio mic capture used by VoIP. Video/camera stays real/fake.
      if (!active || !media || !wantsAudio || wantsVideo) {
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
        const original = mediaModule.getUserMedia.bind(mediaModule);
        mediaModule._whatsealPatched = true;
        mediaModule.getUserMedia = (constraints) => makeInjectedStream(constraints, original);
        report.wa = true;
      }
    } catch (error) {
      report.errors.push('WAGetUserMedia:' + error.message);
    }

    try {
      const md = navigator.mediaDevices;
      if (md && typeof md.getUserMedia === 'function' && !md._whatsealPatched) {
        const original = md.getUserMedia.bind(md);
        md._whatsealPatched = true;
        md.getUserMedia = (constraints) => makeInjectedStream(constraints, original);
        report.navigator = true;
      }
    } catch (error) {
      report.errors.push('navigator:' + error.message);
    }

    s._gumInjectInstalled = true;
    s._gumInject = report;
    return report;
  }

  function setupCallMediaStream() {
    const s = store();
    s._callMediaActive = true;
    if (s._callMedia && s._callMedia.context && s._callMedia.context.state !== 'closed') {
      installGetUserMediaInject();
      return s._callMedia;
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
    s._callMedia = {
      context,
      master,
      destinations: [],
      silence,
      silenceGain,
      sources: [],
    };
    s._callMedia.gum = installGetUserMediaInject();
    return s._callMedia;
  }

  function teardownCallMediaStream() {
    const s = store();
    const media = s._callMedia;
    s._callMediaActive = false;
    if (!media) return { tornDown: false };
    for (const source of media.sources || []) {
      try { source.stop(); } catch { /* ignore */ }
      try { source.disconnect(); } catch { /* ignore */ }
    }
    media.sources = [];
    for (const destination of media.destinations || []) {
      try { media.master.disconnect(destination); } catch { /* already disconnected */ }
    }
    media.destinations = [];
    return { tornDown: true };
  }

  async function playCallAudioBase64(base64, { loop = false } = {}) {
    const media = setupCallMediaStream();
    const { context, master } = media;
    if (context.state === 'suspended') {
      try { await context.resume(); } catch (error) {
        return { success: false, error: 'audio-context-resume:' + error.message };
      }
    }
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
      const call = collection?.activeCall || collection?.lastActiveCall || null;
      if (!call) return null;
      if (typeof call.getState === 'function' && call.getState() === 0) return null;
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

  function connectionState() {
    try {
      const CC = getCallCollection();
      const active = getOngoingCall();
      return {
        isInConnectedCall: Boolean(CC?.isInConnectedCall),
        pendingOfferCount: CC?.pendingOffers ? Object.keys(CC.pendingOffers).length : 0,
        lastActiveCallId: active?.id || CC?.lastActiveCall?.id || null,
        lastActiveCallState: active
          ? (typeof active.getState === 'function' ? active.getState() : active.state)
          : null,
        peerJid: active?.peerJid?._serialized || active?.peerJid || null,
      };
    } catch (error) {
      return { error: error.message, isInConnectedCall: false };
    }
  }

  async function markUserEndedCall(callId) {
    try {
      const collection = getCallCollection();
      const active = collection?.activeCall || collection?.lastActiveCall || null;
      if (!active) return { marked: false, reason: 'no-active-call' };
      if (callId && active.id && active.id !== callId) {
        return { marked: false, reason: 'call-id-mismatch', activeId: active.id, callId };
      }
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
    playCallAudioBase64,
    installGetUserMediaInject,
    getOngoingCall,
    callSnapshot,
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
    async acceptCall(callId, isVideo = false, injectAudio = true) {
      forceEnableWebCalling();
      const voipInit = await ensureVoipInited();
      if (injectAudio) setupCallMediaStream();

      // Prefer media-permission path when available (UI does this before accept).
      let mediaPerm = null;
      try {
        const acquire = window.require('WAWebVoipAcquireMediaStream');
        if (acquire && typeof acquire.checkVoipDevicePermissions === 'function') {
          mediaPerm = await acquire.checkVoipDevicePermissions(Boolean(isVideo));
        }
      } catch (error) {
        mediaPerm = { error: error.message };
      }

      const { iface, via, attempts, gating } = await resolveVoipStack();
      if (!iface || typeof iface.acceptCall !== 'function') {
        return {
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
        };
      }

      // Real signature: acceptCall(unmute, enableVideo)
      const unmute = true;
      const enableVideo = Boolean(isVideo);
      const errors = [];

      try {
        await iface.acceptCall(unmute, enableVideo);
        return {
          success: true,
          method: 'voip-stack.acceptCall(unmute,enableVideo)',
          via,
          callId: callId || null,
          isVideo: enableVideo,
          stackType: iface.type || null,
          mediaPerm,
          voipInit,
        };
      } catch (error) {
        errors.push({ sig: '(unmute,enableVideo)', error: error.message });
      }

      // Fallbacks for older / alternate builds (including mistaken PR callId form).
      for (const [sig, args] of [
        ['(enableVideo)', [enableVideo]],
        ['()', []],
        ['(callId,isVideo)', [callId, enableVideo]],
      ]) {
        try {
          await iface.acceptCall(...args);
          return {
            success: true,
            method: 'voip-stack.acceptCall' + sig,
            via,
            callId: callId || null,
            isVideo: enableVideo,
            stackType: iface.type || null,
            mediaPerm,
          };
        } catch (error) {
          errors.push({ sig, error: error.message });
        }
      }

      return {
        success: false,
        error: errors.map((e) => e.sig + ':' + e.error).join(' | '),
        via,
        method: 'voip-stack.acceptCall',
        attempts,
        gating,
        mediaPerm,
        errors,
      };
    },

    async endCall(callId) {
      const { iface, via, attempts, gating } = await resolveVoipStack();
      await markUserEndedCall(callId);

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
              await iface.endCall(reason, true);
              teardownCallMediaStream();
              return { success: true, method: 'voip-stack.endCall(reason,true)', via, reason };
            } catch (error) {
              // PR #201825 form: endCall(callId, reason)
              try {
                await iface.endCall(callId, reason);
                teardownCallMediaStream();
                return { success: true, method: 'voip-stack.endCall(callId,reason)', via, reason };
              } catch (error2) {
                try {
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

    async rejectCall(callId) {
      // Prefer VoIP reject (PR #201881: userEndedCall + stack.rejectCall()) over WAWap stanza.
      const { iface, via, attempts, gating } = await resolveVoipStack();
      await markUserEndedCall(callId);

      if (iface && typeof iface.rejectCall === 'function') {
        try {
          await iface.rejectCall();
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
      forceEnableWebCalling();
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
      forceEnableWebCalling();
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

  try { forceEnableWebCalling(); } catch { /* ignore */ }
  try { void ensureVoipInited(); } catch { /* ignore */ }
  // Pre-arm mic inject so the first VoIP getUserMedia sees WebAudio destination.
  try { setupCallMediaStream(); } catch { /* ignore */ }
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

export async function voipAcceptCall(page, { callId, isVideo = false, injectAudio = true } = {}) {
  if (!page) return { success: false, error: 'no page' };
  // Ensure bridge is present (idempotent by version).
  await installCallBridge(page);
  return page.evaluate(async (id, video, inject) => {
    return window.__whatsealCallBridgeApi.acceptCall(id, video, inject);
  }, callId, Boolean(isVideo), Boolean(injectAudio));
}

export async function voipEndCall(page, { callId } = {}) {
  if (!page) return { success: false, error: 'no page' };
  await installCallBridge(page);
  return page.evaluate(async (id) => window.__whatsealCallBridgeApi.endCall(id), callId || null);
}

export async function voipRejectCall(page, { callId } = {}) {
  if (!page) return { success: false, error: 'no page' };
  await installCallBridge(page);
  return page.evaluate(async (id) => window.__whatsealCallBridgeApi.rejectCall(id), callId || null);
}

export async function playBotAudioBase64(page, base64) {
  if (!page) return { success: false, error: 'no page' };
  await installCallBridge(page);
  return page.evaluate(async (b64) => window.__whatsealCallBridgeApi.playCallAudioBase64(b64), base64);
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
          if (call && call.id && window._wwjsLastCallId !== call.id) {
            window._wwjsLastCallId = call.id;
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
          if (!call || (typeof call.getState === 'function' && call.getState() === 0)) {
            window.__whatsealCallBridgeApi?.teardownCallMediaStream?.();
          }
        } catch { /* ignore listener errors */ }
      });
      return { success: true, already: false };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
}
