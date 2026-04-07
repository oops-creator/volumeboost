/**
 * Volume Boost – popup script
 *
 * Reads the current gain from the active tab's content script, renders it in
 * the UI, and relays slider / preset changes back to the content script.
 */

"use strict";

// ── DOM refs ────────────────────────────────────────────────────────────────

const slider     = /** @type {HTMLInputElement}  */ (document.getElementById("volume-slider"));
const levelNum   = /** @type {HTMLElement}       */ (document.getElementById("level-number"));
const statusDot  = /** @type {HTMLElement}       */ (document.getElementById("status-dot"));
const statusText = /** @type {HTMLElement}       */ (document.getElementById("status-text"));
const presetBtns = /** @type {NodeListOf<HTMLButtonElement> */ (document.querySelectorAll(".preset-btn"));

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Update all visual elements to reflect the given percentage value.
 * @param {number} pct  Integer percentage (0 – 600).
 */
function renderLevel(pct) {
  levelNum.textContent = String(pct);

  // Slider fill gradient (CSS custom property used by the track background).
  const fillPct = (pct / 600) * 100;
  slider.value = String(pct);
  slider.style.setProperty("--fill", fillPct.toFixed(2) + "%");

  // Active preset highlight.
  presetBtns.forEach((btn) => {
    btn.classList.toggle("active", Number(btn.dataset.value) === pct);
  });
}

/**
 * Update the status indicator.
 * @param {"ready"|"boosting"|"error"|"loading"} state
 * @param {string} message
 */
function setStatus(state, message) {
  statusDot.className  = "status-dot " + (state === "loading" ? "" : state);
  statusText.textContent = message;
}

// ── Core logic ───────────────────────────────────────────────────────────────

/** @type {number|null} */
let activeTabId = null;

/**
 * Send a gain value to the content script and update the stored pref.
 * @param {number} pct  Integer percentage (0 – 600).
 */
async function applyLevel(pct) {
  if (activeTabId === null) return;

  const gain = pct / 100;

  try {
    await browser.tabs.sendMessage(activeTabId, { type: "VB_SET", gain });

    if (pct === 100) {
      setStatus("ready",    "Normal volume");
    } else if (pct === 0) {
      setStatus("ready",    "Muted via boost");
    } else {
      setStatus("boosting", `Boosting to ${pct}%`);
    }
  } catch {
    setStatus("error", "Cannot reach page. Try reloading.");
  }
}

// ── Initialise ───────────────────────────────────────────────────────────────

async function init() {
  setStatus("loading", "Connecting…");

  let tabs;
  try {
    tabs = await browser.tabs.query({ active: true, currentWindow: true });
  } catch {
    setStatus("error", "Could not query active tab.");
    return;
  }

  const tab = tabs[0];
  if (!tab || !tab.id) {
    setStatus("error", "No active tab found.");
    return;
  }

  activeTabId = tab.id;

  // Ask the content script for its current gain.
  let currentPct = 100;
  try {
    const response = await browser.tabs.sendMessage(activeTabId, { type: "VB_GET" });
    if (response && typeof response.gain === "number") {
      currentPct = Math.round(response.gain * 100);
    }
    setStatus(
      currentPct > 100 ? "boosting" : "ready",
      currentPct > 100 ? `Boosting to ${currentPct}%` : "Normal volume"
    );
  } catch {
    // Content script might not be active (browser:// pages, PDF viewer, etc.)
    setStatus("error", "Not supported on this page.");
  }

  renderLevel(currentPct);
}

// ── Event listeners ──────────────────────────────────────────────────────────

slider.addEventListener("input", () => {
  const pct = Number(slider.value);
  renderLevel(pct);
  applyLevel(pct);
});

presetBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    const pct = Number(btn.dataset.value);
    renderLevel(pct);
    applyLevel(pct);
  });
});

// ── Boot ─────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", init);
