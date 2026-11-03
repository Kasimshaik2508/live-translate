// notes.js — Class Notes add-on for Live Translate.
//
// WHAT IT DOES
//   1. Watches the translation lines Live Translate shows on screen (the #log list) and
//      saves each finished line to the browser's database (IndexedDB).
//   2. Every ~2 minutes asks Gemini to turn the new lines into structured notes, saved too.
//   3. Lets you ask questions (answers are split into "From class" / "Beyond the class").
//   4. Catch-up: summarise what was said between two clock times.
//
// WHY THIS DESIGN
//   - Your app has no server: each person pastes their own Gemini key, kept in the browser.
//     So this add-on follows the same idea — no server, no account, no new key. It reads the
//     same key from localStorage and calls Gemini straight from the browser.
//   - It does NOT edit app.js. It just reads the page (#log rows) — so your working
//     translation code can't be broken by it.
//   - Notes live in IndexedDB: a real database built into every browser. It handles lots of
//     text, survives refreshes/closing, and stays private on the device. Trade-off: notes are
//     per device/browser, so we include a "Download .md" button as a backup/export.

import { GoogleGenAI } from "https://cdn.jsdelivr.net/npm/@google/genai@2.29.1/+esm";
import {
  renderMarkdown, filterByTimeRange, transcriptText, fmtTime, dateKey,
  notesPrompt, askPrompt, catchupPrompt,
} from "./notes-core.js";

// ---------- settings you may want to change ----------
// Text model for notes/answers. This is the SAME model gemini.js uses for translation, so we know
// your key can use it. Google retires models over time: if you ever see a "404 / no longer available"
// message, change this one line to a current model name.
const MODEL = "gemini-3.5-flash-lite";
const KEY_NAME = "gemini_api_key"; // same localStorage key app.js uses
const POLL_MS = 4000;              // how often we look at the screen for new lines
const STABLE_MS = 6000;            // a line is "finished" once its text stops changing this long
const NOTES_EVERY_MS = 120000;     // make notes at most every 2 minutes
const PREV_NOTES_CHARS = 1500;     // how much old notes we show Gemini for continuity

// ---------- tiny IndexedDB wrapper ----------
// Three "tables" (object stores):
//   sessions: one per class   {id, title, startedAt, endedAt}
//   chunks:   raw saved lines {id, sessionId, text, src, ts}   <- the full transcript (kept so notes can be redone)
//   notes:    generated notes {id, sessionId, markdown, fromTs, toTs, toChunkId}
const dbPromise = new Promise((resolve, reject) => {
  const open = indexedDB.open("class-notes", 1);
  open.onupgradeneeded = () => {
    const db = open.result;
    db.createObjectStore("sessions", { keyPath: "id", autoIncrement: true });
    db.createObjectStore("chunks", { keyPath: "id", autoIncrement: true })
      .createIndex("bySession", "sessionId");
    db.createObjectStore("notes", { keyPath: "id", autoIncrement: true })
      .createIndex("bySession", "sessionId");
  };
  open.onsuccess = () => resolve(open.result);
  open.onerror = () => reject(open.error);
});

const asPromise = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

async function run(store, mode, fn) {
  const db = await dbPromise;
  const tx = db.transaction(store, mode);
  const result = await fn(tx.objectStore(store));
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  return result;
}
const dbAdd = (store, obj) => run(store, "readwrite", (s) => asPromise(s.add(obj)));
const dbPut = (store, obj) => run(store, "readwrite", (s) => asPromise(s.put(obj)));
const dbAll = (store) => run(store, "readonly", (s) => asPromise(s.getAll()));
const dbBySession = (store, id) => run(store, "readonly", (s) => asPromise(s.index("bySession").getAll(id)));
const byId = (a, b) => a.id - b.id;

// ---------- Gemini ----------
let client = null, clientKey = "";
function getClient() {
  let key = "";
  try { key = localStorage.getItem(KEY_NAME) || ""; } catch { /* storage blocked */ }
  if (!key) throw new Error("Add your Gemini key first (Settings button at the top).");
  if (!client || key !== clientKey) { client = new GoogleGenAI({ apiKey: key }); clientKey = key; }
  return client;
}

async function askGemini(prompt) {
  const res = await getClient().models.generateContent({ model: MODEL, contents: prompt });
  const text = (res.text ?? "").trim();
  if (!text) throw new Error("Gemini returned an empty answer. Try again.");
  return text;
}

function friendly(err) {
  const msg = String(err?.message ?? err);
  if (/404|NOT_FOUND|no longer available/i.test(msg)) return `The Gemini model "${MODEL}" is not available for your key. Change MODEL at the top of notes.js to a current model name.`;
  if (/429|quota|RESOURCE_EXHAUSTED|rate/i.test(msg)) return "Gemini's free limit is reached for now. Wait a minute and try again.";
  if (/API key|API_KEY|401|403|PERMISSION/i.test(msg)) return "There is a problem with your Gemini key. Check it in Settings.";
  return msg.slice(0, 200);
}

// ---------- the panel (injected into the page, so index.html barely changes) ----------
const css = document.createElement("style");
css.textContent = `
  #cn { margin-top: 24px; }
  #cn h3 { font-size: 1rem; margin: 18px 0 8px; }
  #cn h4, #cn h5, #cn h6 { margin: 12px 0 4px; }
  #cn ul { margin: 0 0 8px; padding-left: 20px; }
  #cn p { margin: 0 0 8px; }
  #cn .keyrow { align-items: center; margin-bottom: 8px; }
  #cn .box { border: 1px solid var(--line); border-radius: 8px; padding: 10px 14px; margin-top: 8px; }
  #cn .notes { max-height: 340px; overflow: auto; }
  #cn input[type=time] { font: inherit; color: var(--text); background: var(--panel);
    border: 1px solid var(--line); border-radius: 8px; padding: 7px 10px; }
  #cn .inline { flex-direction: row; align-items: center; gap: 6px; }
`;
document.head.append(css);

const panel = document.createElement("section");
panel.id = "cn";
panel.className = "card";
panel.hidden = true;
panel.innerHTML = `
  <h2>Class notes</h2>
  <label>Start as <select id="cnPick"></select></label>
  <div class="keyrow">
    <input id="cnTitle" type="text" placeholder="Class title (optional)">
    <button id="cnStart">Start class</button>
    <button id="cnEnd" class="secondary" hidden>End class</button>
  </div>
  <p id="cnStatus" class="note">Press Start class, then Start listening above. Notes are saved on this device.</p>

  <label>Showing class <select id="cnSession"></select></label>
  <div id="cnNotes" class="box notes note">No notes yet.</div>
  <div class="keyrow" style="margin-top:8px">
    <button id="cnUpdate" class="secondary small">Update notes now</button>
    <button id="cnExport" class="secondary small">Download .md</button>
  </div>

  <h3>Ask a question</h3>
  <form id="cnAskForm" class="keyrow">
    <input id="cnQ" type="text" placeholder="Ask about this class, or anything related">
    <button type="submit">Ask</button>
  </form>
  <label class="inline"><input type="checkbox" id="cnAll"> Search all my classes</label>
  <div id="cnAnswer" class="box" hidden></div>

  <h3>Catch up on what I missed</h3>
  <div class="keyrow">
    <label class="inline">Day <input type="date" id="cnDate"></label>
    <label class="inline">From <input type="time" id="cnFrom"></label>
    <label class="inline">To <input type="time" id="cnTo"></label>
    <button id="cnCatch" class="secondary small">Summarise</button>
  </div>
  <div id="cnCatchOut" class="box" hidden></div>
`;
document.querySelector("main").append(panel);
const $ = (id) => panel.querySelector("#" + id);

const setStatus = (text, bad = false) => { $("cnStatus").textContent = text; $("cnStatus").style.color = bad ? "var(--error)" : ""; };
function show(box, html) { box.hidden = false; box.innerHTML = html; }
const plain = (t) => `<p class="note">${t}</p>`;

// ---------- state ----------
let current = null;       // the class being recorded right now (null if none)
let busy = false;         // true while Gemini is writing notes (prevents two at once)
let lastNotesAt = Date.now();
let sessions = [];        // all saved classes, newest first

// ---------- 1. capture lines from the screen ----------
// Live Translate keeps adding/updating ".row" elements inside #log. A row's ".dst" text is the
// translated line. While Gemini is still streaming, the text keeps changing, so we only save
// a row once its text has stayed the same for STABLE_MS. We tag rows with data-* attributes
// (cnSaved etc.) so we never save one twice.
let savedCount = 0; // lines saved in the class being recorded (shown in the status line)
async function saveRow(row, text) {
  row.dataset.cnSaved = "1";
  const src = row.querySelector(".src")?.textContent.trim() ?? "";
  await dbAdd("chunks", { sessionId: current.id, text, src, ts: Number(row.dataset.cnT) || Date.now() });
  savedCount += 1;
  if (current) setStatus(`Recording "${current.title}" — ${savedCount} line${savedCount === 1 ? "" : "s"} saved.`);
}

const isErrorLine = (t) => /^\[.*\]$/.test(t); // app.js shows failures as "[message]"

function scanRows({ force = false } = {}) {
  const now = Date.now();
  const jobs = [];
  for (const row of document.querySelectorAll("#log .row")) {
    if (row.dataset.cnSaved || row.classList.contains("interim")) continue;
    const text = row.querySelector(".dst")?.textContent.trim() ?? "";
    if (!row.dataset.cnT) row.dataset.cnT = String(now);
    if (text !== row.dataset.cnText) { row.dataset.cnText = text; row.dataset.cnChanged = String(now); }
    const stable = now - Number(row.dataset.cnChanged) >= STABLE_MS;
    if (text && !isErrorLine(text) && (stable || force)) jobs.push(saveRow(row, text));
  }
  return Promise.all(jobs);
}

setInterval(async () => {
  // Show our panel only when the main translate screen is visible (not on the key setup screen).
  panel.hidden = document.getElementById("app")?.hidden ?? true;
  if (!rangeTouched) setDefaultRange();
  if (!current) return;
  try {
    await scanRows();
    if (!busy && Date.now() - lastNotesAt >= NOTES_EVERY_MS) await makeNotes(current);
  } catch (err) { setStatus(friendly(err), true); }
}, POLL_MS);

// ---------- 2. turn new lines into notes ----------
// We remember (toChunkId) the last line each note covered, so every run only sends NEW lines.
async function makeNotes(session, { manual = false } = {}) {
  while (busy) await new Promise((r) => setTimeout(r, 300)); // wait our turn
  busy = true;
  lastNotesAt = Date.now();
  try {
    const chunks = (await dbBySession("chunks", session.id)).sort(byId);
    const notes = (await dbBySession("notes", session.id)).sort(byId);
    const doneUntil = notes.at(-1)?.toChunkId ?? 0;
    const fresh = chunks.filter((c) => c.id > doneUntil);
    if (!fresh.length) {
      // Say WHY nothing happened, instead of staying silent.
      if (manual) {
        setStatus(chunks.length
          ? "All saved lines are already in the notes. Say or type something new."
          : "No lines saved in this class yet. Press Start class FIRST, then speak or type; lines typed before Start class are ignored.", true);
      }
      return;
    }
    setStatus("Writing notes…");
    const previous = notes.map((n) => n.markdown).join("\n\n").slice(-PREV_NOTES_CHARS);
    let markdown = await askGemini(notesPrompt(transcriptText(fresh), previous));
    // If this class is being continued on a later day, mark where the new day starts.
    const lastDay = notes.length ? dateKey(notes.at(-1).toTs) : null;
    if (lastDay && lastDay !== dateKey(fresh[0].ts)) {
      markdown = `## Continued on ${new Date(fresh[0].ts).toLocaleDateString()}\n\n${markdown}`;
    }
    await dbAdd("notes", {
      sessionId: session.id, markdown,
      fromTs: fresh[0].ts, toTs: fresh.at(-1).ts, toChunkId: fresh.at(-1).id,
    });
    setStatus(current ? `Recording — notes updated at ${fmtTime(Date.now())}.` : "Notes saved.");
    await refresh();
  } catch (err) {
    setStatus(friendly(err), true);
  } finally {
    busy = false;
  }
}

// ---------- start / end a class ----------
$("cnStart").onclick = async () => {
  // Rows already on screen belong to earlier talk — mark them so they are not saved into this class.
  document.querySelectorAll("#log .row").forEach((r) => { r.dataset.cnSaved = "1"; });
  const pick = $("cnPick").value;
  if (pick === "new") {
    const started = Date.now();
    const title = $("cnTitle").value.trim() || `Class ${new Date(started).toLocaleDateString()}`;
    const id = await dbAdd("sessions", { title, startedAt: started, endedAt: null });
    current = { id, title, startedAt: started, endedAt: null };
  } else {
    // CONTINUE a previous class: reuse the same session, so new lines and new notes are
    // added to it. Its old transcript and notes stay untouched, and the last notes are shown
    // to Gemini for continuity (see makeNotes).
    current = sessions.find((s) => s.id === Number(pick));
    current.endedAt = null;
    await dbPut("sessions", current);
  }
  lastNotesAt = Date.now();
  savedCount = 0;
  $("cnStart").hidden = true; $("cnEnd").hidden = false; $("cnTitle").disabled = true; $("cnPick").disabled = true;
  setStatus(pick === "new"
    ? `Started a NEW class "${current.title}". Now press Start listening above. Lines are saved automatically.`
    : `CONTINUING "${current.title}" (first started at ${fmtTime(current.startedAt)}). New lines and notes are added to it.`);
  await refresh(current.id);
};

// Picking an existing class hides the title box (the title already exists).
$("cnPick").onchange = () => { $("cnTitle").hidden = $("cnPick").value !== "new"; };

$("cnEnd").onclick = async () => {
  const session = current;
  if (!session) return;
  $("cnEnd").disabled = true;
  try {
    await scanRows({ force: true });          // save whatever is still on screen
    session.endedAt = Date.now();
    await dbPut("sessions", session);
    current = null;
    await makeNotes(session);                 // final notes for the last few minutes
  } finally {
    $("cnStart").hidden = false; $("cnEnd").hidden = true; $("cnEnd").disabled = false;
    $("cnTitle").disabled = false; $("cnPick").disabled = false;
    $("cnTitle").value = "";
    $("cnPick").value = "new"; // next time starts a fresh class unless you choose to continue one
    await refresh(session.id);
  }
};

$("cnUpdate").onclick = async () => {
  const id = Number($("cnSession").value);
  if (!id) return;
  try { await scanRows({ force: true }); } catch (err) { setStatus(`Could not save lines: ${friendly(err)}`, true); return; }
  await makeNotes(sessions.find((s) => s.id === id), { manual: true });
};

// ---------- 3. show notes / switch class / export ----------
async function refresh(selectId) {
  sessions = (await dbAll("sessions")).sort((a, b) => b.id - a.id);
  const select = $("cnSession");
  const keep = selectId ?? (Number(select.value) || sessions[0]?.id);
  // Date AND start time, so two classes with the same title are easy to tell apart.
  const label = (s) => `${s.title} · ${new Date(s.startedAt).toLocaleDateString()} ${fmtTime(s.startedAt)}`;
  select.replaceChildren(...sessions.map((s) => new Option(label(s), s.id)));
  if (keep) select.value = String(keep);

  // The "Start as" picker: a brand-new class, or continue one of the saved classes.
  const pick = $("cnPick");
  const chosen = pick.value;
  pick.replaceChildren(
    new Option("New class", "new"),
    ...sessions.map((s) => new Option(`Continue: ${label(s)}`, s.id)),
  );
  pick.value = [...pick.options].some((o) => o.value === chosen) ? chosen : "new";
  $("cnTitle").hidden = pick.value !== "new";
  await showNotes();
}

async function notesFor(id) {
  return (await dbBySession("notes", id)).sort(byId);
}

async function showNotes() {
  const id = Number($("cnSession").value);
  if (!id) { show($("cnNotes"), plain("No classes yet. Press Start class.")); return; }
  const notes = await notesFor(id);
  show($("cnNotes"), notes.length
    ? renderMarkdown(notes.map((n) => n.markdown).join("\n\n"))
    : plain("Notes appear here a couple of minutes after the teacher starts talking."));
}
$("cnSession").onchange = showNotes;

$("cnExport").onclick = async () => {
  const id = Number($("cnSession").value);
  const session = sessions.find((s) => s.id === id);
  if (!session) return;
  const notes = await notesFor(id);
  const md = `# ${session.title}\n\n_${new Date(session.startedAt).toLocaleString()}_\n\n`
    + (notes.map((n) => n.markdown).join("\n\n") || "(no notes yet)");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([md], { type: "text/markdown" }));
  link.download = `${session.title.replace(/[^\w\- ]+/g, "").trim() || "class-notes"}.md`;
  link.click();
  URL.revokeObjectURL(link.href);
};

// ---------- 4. ask questions ----------
// Simple "RAG" without a vector database: a class's notes are only a few pages, so we
// just hand ALL the relevant notes to Gemini together with the question. Lines that were
// said but are not yet turned into notes are added too, so nothing is missing.
async function classContext(ids) {
  const parts = [];
  for (const id of ids) {
    const session = sessions.find((s) => s.id === id);
    if (!session) continue;
    const notes = await notesFor(id);
    const doneUntil = notes.at(-1)?.toChunkId ?? 0;
    const pending = (await dbBySession("chunks", id)).sort(byId).filter((c) => c.id > doneUntil);
    parts.push(
      `### Class: ${session.title} (${new Date(session.startedAt).toLocaleDateString()})\n`
      + notes.map((n) => n.markdown).join("\n\n")
      + (pending.length ? `\n\n(Said in class, not yet in notes:)\n${transcriptText(pending)}` : ""),
    );
  }
  return parts.join("\n\n");
}

$("cnAskForm").onsubmit = async (e) => {
  e.preventDefault();
  const question = $("cnQ").value.trim();
  if (!question) return;
  const ids = $("cnAll").checked ? sessions.map((s) => s.id) : [Number($("cnSession").value)].filter(Boolean);
  show($("cnAnswer"), plain("Thinking…"));
  try {
    const answer = await askGemini(askPrompt(await classContext(ids), question));
    show($("cnAnswer"), renderMarkdown(answer));
  } catch (err) {
    show($("cnAnswer"), plain(friendly(err)));
  }
};

// ---------- 5. catch-up ----------
const hhmm = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

// Default window = the last 15 minutes up to NOW. It keeps following the clock until you edit
// one of the three boxes yourself (after that we leave your values alone).
let rangeTouched = false;
function setDefaultRange() {
  const now = new Date();
  $("cnDate").value = dateKey(now.getTime());
  $("cnTo").value = hhmm(now);
  $("cnFrom").value = hhmm(new Date(now - 15 * 60000));
}
for (const id of ["cnDate", "cnFrom", "cnTo"]) $(id).addEventListener("input", () => { rangeTouched = true; });
setDefaultRange();

$("cnCatch").onclick = async () => {
  const id = Number($("cnSession").value);
  if (!id) return;
  const from = $("cnFrom").value, to = $("cnTo").value;
  const chunks = filterByTimeRange((await dbBySession("chunks", id)).sort(byId), from, to, $("cnDate").value);
  if (!chunks.length) { show($("cnCatchOut"), plain("No speech was saved between those times on that day.")); return; }
  show($("cnCatchOut"), plain("Summarising…"));
  try {
    show($("cnCatchOut"), renderMarkdown(await askGemini(catchupPrompt(transcriptText(chunks), from, to))));
  } catch (err) {
    show($("cnCatchOut"), plain(friendly(err)));
  }
};

// ---------- on page load ----------
// If the tab was closed in the middle of a class, close that class now and write its last notes.
(async () => {
  await refresh();
  for (const s of sessions.filter((x) => !x.endedAt)) {
    const last = (await dbBySession("chunks", s.id)).sort(byId).at(-1);
    s.endedAt = last?.ts ?? s.startedAt;
    await dbPut("sessions", s);
    if (last) makeNotes(s); // errors are shown in the status line
  }
})();
