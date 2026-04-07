/**
 * Volume Boost – content script
 *
 * Uses the Web Audio API to route all <audio>/<video> elements through a
 * GainNode so volume can be amplified beyond the browser's native 100% cap.
 *
 * Lifecycle:
 *   1. On page load we read any previously stored gain for this hostname from
 *      browser.storage.local and prepare to apply it on the first user
 *      interaction (AudioContext creation requires a user gesture).
 *   2. The popup sends VB_SET messages whenever the user moves the slider.
 *   3. A MutationObserver ensures dynamically added media elements (SPAs,
 *      YouTube, etc.) are connected to the gain node as they appear.
 */

(function () {
  "use strict";

  // ── State ────────────────────────────────────────────────────────────────

  /** @type {AudioContext|null} */
  let audioCtx = null;

  /** @type {GainNode|null} */
  let gainNode = null;

  /** Current gain multiplier (1.0 = 100 %). */
  let currentGain = 1.0;

  /**
   * Elements that have already been connected to the gain node.
   * WeakSet so GC can clean up detached elements automatically.
   * @type {WeakSet<HTMLMediaElement>}
   */
  const connected = new WeakSet();

  // ── Audio context helpers ─────────────────────────────────────────────────

  /**
   * Create (or resume) the AudioContext and its GainNode.
   * MUST be called from within a user-gesture handler the first time.
   */
  function ensureAudioCtx() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      gainNode = audioCtx.createGain();
      gainNode.gain.value = currentGain;
      gainNode.connect(audioCtx.destination);
    }

    // Browsers suspend the context if no user gesture has occurred yet.
    if (audioCtx.state === "suspended") {
      audioCtx.resume();
    }
  }

  /**
   * Connect a single media element to the shared gain node.
   * Safe to call multiple times – already-connected elements are skipped.
   * @param {HTMLMediaElement} el
   */
  function connectElement(el) {
    if (connected.has(el)) return;
    connected.add(el);

    try {
      ensureAudioCtx();
      const source = audioCtx.createMediaElementSource(el);
      source.connect(gainNode);
    } catch (err) {
      // createMediaElementSource throws if the element has already been
      // captured by a different AudioContext (e.g. the page itself uses
      // the Web Audio API).  We silently skip those elements.
      connected.delete(el);
    }
  }

  /** Connect every <audio> and <video> currently in the document. */
  function connectAll() {
    document.querySelectorAll("audio, video").forEach(connectElement);
  }

  // ── MutationObserver – catch dynamically added media elements ─────────────

  const observer = new MutationObserver((mutations) => {
    // Skip work if the AudioContext hasn't been started yet.
    if (!audioCtx) return;

    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;

        if (node.matches("audio, video")) {
          connectElement(/** @type {HTMLMediaElement} */ (node));
        }

        // Container nodes may have media children.
        if (typeof node.querySelectorAll === "function") {
          node.querySelectorAll("audio, video").forEach(connectElement);
        }
      }
    }
  });

  const observerRoot = document.body || document.documentElement;
  observer.observe(observerRoot, { childList: true, subtree: true });

  // ── Persist & restore gain across page loads ──────────────────────────────

  const STORAGE_KEY = "vb_host_gains";
  const hostname = window.location.hostname;

  /**
   * Read the stored gain for this hostname and, if it differs from the
   * default, schedule its application on the next user interaction so we
   * don't mute the page by creating a suspended AudioContext prematurely.
   */
  browser.storage.local.get(STORAGE_KEY).then((result) => {
    const gains = result[STORAGE_KEY] || {};
    const stored = gains[hostname];

    if (typeof stored === "number" && stored !== 1.0) {
      currentGain = stored;

      const applyOnInteraction = () => {
        connectAll();
        ensureAudioCtx();
        gainNode.gain.value = currentGain;
      };

      // Apply on the next click or keydown (whichever comes first).
      document.addEventListener("click",   applyOnInteraction, { once: true });
      document.addEventListener("keydown", applyOnInteraction, { once: true });
    }
  });

  /** Persist the current gain value to storage for this hostname. */
  function persistGain(gain) {
    browser.storage.local.get(STORAGE_KEY).then((result) => {
      const gains = result[STORAGE_KEY] || {};
      gains[hostname] = gain;
      browser.storage.local.set({ [STORAGE_KEY]: gains });
    });
  }

  // ── Message handler (from popup) ──────────────────────────────────────────

  browser.runtime.onMessage.addListener((message) => {
    // ── VB_SET: apply a new gain value ──
    if (message.type === "VB_SET") {
      const gain = Number(message.gain);
      if (!Number.isFinite(gain) || gain < 0) {
        return Promise.resolve({ error: "Invalid gain value" });
      }

      currentGain = gain;
      connectAll();
      ensureAudioCtx();
      gainNode.gain.value = currentGain;
      persistGain(currentGain);

      return Promise.resolve({ ok: true, gain: currentGain });
    }

    // ── VB_GET: report the current gain value ──
    if (message.type === "VB_GET") {
      return Promise.resolve({ gain: currentGain });
    }

    // Unknown message type – not our concern.
    return undefined;
  });
})();
