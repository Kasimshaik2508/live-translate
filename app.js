import { GoogleGenAI } from "https://cdn.jsdelivr.net/npm/@google/genai@2.29.1/+esm";
import { LiveTranslator, checkKey, describeError, parseReply, streamTranslation } from "./gemini.js";

const $ = (id) => document.getElementById(id);

const LANGS = [
  ["en-US", "English"], ["hi-IN", "Hindi"], ["te-IN", "Telugu"], ["ta-IN", "Tamil"],
  ["kn-IN", "Kannada"], ["ml-IN", "Malayalam"], ["mr-IN", "Marathi"], ["bn-IN", "Bengali"],
  ["gu-IN", "Gujarati"], ["pa-IN", "Punjabi"], ["ur-PK", "Urdu"], ["es-ES", "Spanish"],
  ["fr-FR", "French"], ["de-DE", "German"], ["it-IT", "Italian"], ["pt-BR", "Portuguese"],
  ["ru-RU", "Russian"], ["ar-SA", "Arabic"], ["tr-TR", "Turkish"], ["zh-CN", "Chinese (Mandarin)"],
  ["ja-JP", "Japanese"], ["ko-KR", "Korean"], ["id-ID", "Indonesian"], ["vi-VN", "Vietnamese"],
];
const targetName = () => LANGS.find(([c]) => c === $("target").value)[1];
const targetCode = () => $("target").value.split("-")[0];

// --- Small storage helpers (storage can be unavailable, e.g. in private windows) ---
const memory = {};
const load = (k, d = "") => { try { return localStorage.getItem(k) ?? d; } catch { return memory[k] ?? d; } };
const store = (k, v) => { try { localStorage.setItem(k, v); } catch { memory[k] = v; } };
const forget = (k) => { try { localStorage.removeItem(k); } catch { delete memory[k]; } };
const KEY = "gemini_api_key";

let ai = null;

// --- Key setup screen ---
function showSetup() {
  const key = load(KEY);
  $("setupTitle").textContent = key ? "Your Gemini API key" : "Add your free Gemini API key";
  $("savedKey").hidden = !key;
  $("savedKeyHint").textContent = key ? `…${key.slice(-4)}` : "";
  $("keyInput").value = "";
  $("keyInput").placeholder = key ? "Paste a new key to replace it" : "Paste your API key";
  $("keyError").textContent = "";
  $("setup").hidden = false;
  $("app").hidden = true;
  $("settingsBtn").hidden = true;
}

function showApp() {
  ai = new GoogleGenAI({ apiKey: load(KEY) });
  $("setup").hidden = true;
  $("app").hidden = false;
  $("settingsBtn").hidden = false;
}

$("keyForm").onsubmit = async (e) => {
  e.preventDefault();
  const key = $("keyInput").value.trim();
  if (!key) { $("keyError").textContent = "Paste your key first."; return; }
  $("keySave").disabled = true;
  $("keySave").textContent = "Checking…";
  $("keyError").textContent = "";
  try {
    await checkKey(new GoogleGenAI({ apiKey: key }));
    store(KEY, key);
    showApp();
  } catch (err) {
    const message = describeError(err);
    $("keyError").textContent = /isn't valid/.test(message)
      ? "That key isn't valid. Copy it again from AI Studio and paste the whole key."
      : message;
  } finally {
    $("keySave").disabled = false;
    $("keySave").textContent = "Save key";
  }
};
$("keyDone").onclick = showApp;
$("keyRemove").onclick = () => { forget(KEY); ai = null; showSetup(); };
$("settingsBtn").onclick = () => { if (listening) stopListening(); showSetup(); };

// --- Controls ---
for (const [code, name] of LANGS) $("target").add(new Option(name, code));
$("target").value = load("target", "en-US");
if (!$("target").value) $("target").value = "en-US";
$("mode").value = load("mode", "continuous");
if (!$("mode").value) $("mode").value = "continuous";

const MODE_HINTS = {
  continuous: "Translates while people talk. Best when the class mostly uses one language "
    + "(mixing in English is fine). If speakers switch between several languages, use Sentence by sentence.",
  sentences: "Each line appears about a second after the speaker pauses, tagged with the "
    + "language. Handles speakers switching between languages best.",
};
const showModeHint = () => { $("modeHint").textContent = MODE_HINTS[$("mode").value]; };
showModeHint();

function setStatus(text, kind = "") {
  $("status").textContent = text;
  $("status").className = kind;
}

function addRow(text, interim = false) {
  const row = document.createElement("div");
  row.className = "row" + (interim ? " interim" : "");
  row.innerHTML = '<div class="src"></div><div><span class="tag"></span><div class="dst"></div></div>';
  row.querySelector(".src").textContent = text;
  $("log").append(row);
  row.scrollIntoView({ block: "nearest", behavior: "smooth" });
  return row;
}

function showReply(row, raw) {
  const reply = parseReply(raw);
  row.querySelector(".tag").textContent = reply.lang;
  row.querySelector(".dst").textContent = reply.text;
  return reply;
}

// --- Typed text ---
const typedHistory = [];

$("typed").onsubmit = async (e) => {
  e.preventDefault();
  const text = $("typedText").value.trim();
  if (!text) return;
  $("typedText").value = "";
  const row = addRow(text);
  let raw = "";
  try {
    for await (const piece of streamTranslation(ai, text, targetName(), typedHistory.slice(-6))) {
      raw += piece;
      showReply(row, raw);
    }
    typedHistory.push({ source: text, translation: parseReply(raw).text });
  } catch (err) {
    row.querySelector(".dst").textContent = `[${describeError(err)}]`;
  }
};

// --- Live listening ---
let listening = false;
let mic = null, audioCtx = null, translator = null, wakeLock = null, interimRow = null;
const sentenceRows = new Map();

// Continuous mode: heard and translated words arrive as separate streams of fragments.
// A pause starts a new line; translations fill lines in order, moving to the next line
// once the current one's translation ends a sentence or goes quiet.
const PAUSE_MS = 1500;
const live = { lines: [], heardAt: 0, outIndex: 0, outAt: 0 };
const endsSentence = (text) => /[.?!।]\s*$/.test(text);

function appendText(el, fragment) {
  el.textContent = (el.textContent + fragment).replace(/^\s+/, "");
}

function onHeard(fragment) {
  const now = Date.now();
  let line = live.lines.at(-1);
  const src = line?.querySelector(".src").textContent ?? "";
  const longSentence = src.length > 160 && endsSentence(src);
  if (!line || now - live.heardAt > PAUSE_MS || longSentence) {
    line = addRow("");
    live.lines.push(line);
  }
  live.heardAt = now;
  appendText(line.querySelector(".src"), fragment);
}

function onTranslated(fragment) {
  const now = Date.now();
  if (!live.lines.length) live.lines.push(addRow(""));
  let line = live.lines[live.outIndex];
  const dst = line.querySelector(".dst").textContent;
  const hasNewer = live.outIndex < live.lines.length - 1;
  if (hasNewer && dst && (endsSentence(dst) || now - live.outAt > PAUSE_MS)) {
    live.outIndex += 1;
    line = live.lines[live.outIndex];
  }
  live.outAt = now;
  appendText(line.querySelector(".dst"), fragment);
  line.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

const handlers = {
  listening: () => setStatus("Listening… speak in any language", "live"),
  heard: onHeard,
  translated: onTranslated,
  interim: (text) => {
    if (!interimRow) interimRow = addRow("", true);
    interimRow.querySelector(".src").textContent = text;
  },
  final: (id, text) => {
    if (interimRow) { interimRow.remove(); interimRow = null; }
    sentenceRows.set(id, addRow(text));
  },
  translation: (id, raw) => {
    const row = sentenceRows.get(id);
    if (row) showReply(row, raw);
  },
  error: (message) => {
    stopListening();
    setStatus(message, "bad");
  },
};

// Keep phones from locking the screen (which stops the microphone) while listening.
async function keepAwake() {
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch { wakeLock = null; }
}
document.addEventListener("visibilitychange", () => {
  if (listening && document.visibilityState === "visible") keepAwake();
});

async function startListening() {
  setStatus("Waiting for microphone access…");
  try {
    mic = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: false, noiseSuppression: true, autoGainControl: true },
    });
  } catch {
    setStatus("Microphone access was blocked. Allow it for this site and try again.", "bad");
    return;
  }
  listening = true;
  setStatus("Connecting to Gemini…");
  $("toggle").textContent = "Stop";
  $("toggle").classList.add("live");
  $("meter").hidden = false;
  live.lines = []; live.outIndex = 0;
  keepAwake();

  translator = new LiveTranslator(ai, {
    mode: $("mode").value, targetLang: targetName(), targetCode: targetCode(), on: handlers,
  });

  // The browser resamples the microphone to 16 kHz for us.
  audioCtx = new AudioContext({ sampleRate: 16000 });
  await audioCtx.audioWorklet.addModule("audio-worklet.js");
  const worklet = new AudioWorkletNode(audioCtx, "pcm16");
  audioCtx.createMediaStreamSource(mic).connect(worklet);
  worklet.connect(audioCtx.destination); // outputs silence; keeps the node running
  worklet.port.onmessage = ({ data }) => {
    $("meter").firstElementChild.style.width = `${Math.min(100, data.peak * 140)}%`;
    translator?.sendAudio(data.pcm); // buffered until the connection is open
  };

  try {
    await translator.start();
  } catch (err) {
    handlers.error(describeError(err));
  }
}

function stopListening() {
  listening = false;
  translator?.stop();
  mic?.getTracks().forEach((t) => t.stop());
  audioCtx?.close();
  wakeLock?.release().catch(() => {});
  translator = mic = audioCtx = wakeLock = null;
  if (interimRow) { interimRow.remove(); interimRow = null; }
  $("toggle").textContent = "Start listening";
  $("toggle").classList.remove("live");
  $("meter").hidden = true;
  setStatus("Stopped.");
}

if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) {
  $("toggle").disabled = true;
  setStatus("This browser can't record audio. Use a current Chrome, Edge or Safari, or type below.", "bad");
}

$("toggle").onclick = () => (listening ? stopListening() : startListening());
$("clear").onclick = () => {
  $("log").replaceChildren();
  sentenceRows.clear(); interimRow = null; typedHistory.length = 0;
  live.lines = []; live.outIndex = 0;
};
for (const id of ["target", "mode"]) {
  $(id).onchange = () => {
    store(id, $(id).value);
    showModeHint();
    if (listening) { stopListening(); startListening(); }
  };
}

// --- Install as an app ---
let installPrompt = null;
const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installPrompt = e;
  $("installHint").innerHTML = "Use this like an app: ";
  const btn = document.createElement("button");
  btn.className = "small";
  btn.textContent = "Install Live Translate";
  btn.onclick = async () => { installPrompt.prompt(); await installPrompt.userChoice; $("installHint").hidden = true; };
  $("installHint").append(btn);
  $("installHint").hidden = false;
});
if (!standalone && /iphone|ipad|ipod/i.test(navigator.userAgent)) {
  $("installHint").textContent =
    "To use this like an app on iPhone: tap the Share button in Safari, then “Add to Home Screen”.";
  $("installHint").hidden = false;
}
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

// --- Start ---
if (load(KEY)) showApp(); else showSetup();
