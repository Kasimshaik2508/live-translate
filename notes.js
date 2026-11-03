// notes.js — Class Notes add-on for Live Translate.
//
// WHAT IT DOES
//   1. Watches the translation lines Live Translate shows on screen (the #log list) and saves
//      each finished line.
//   2. Every ~2 minutes asks Gemini to turn the new lines into structured notes, saved too.
//   3. Lets you ask questions (answers are split into "From class" / "Beyond the class").
//   4. Catch-up: summarise what was said between two clock times.
//   5. Rename / delete classes, continue a previous class.
//
// WHERE THE DATA LIVES (two "storage adapters" with the SAME functions)
//   - cloud : a Supabase (Postgres) database. You sign in with an email code, and every row
//             carries your user id. Database rules (row-level security) make sure each person
//             can only ever read their own rows. Notes follow your account, on any device.
//   - local : IndexedDB, a database built into the browser. Used automatically if the Supabase
//             settings below are left empty. Notes stay on that one device.
//   The rest of the file only calls dbAdd / dbPut / dbAll / dbBySession / dbDeleteSession, so it
//   does not care which one is behind them. (This is called the adapter pattern.)
//
// WHY IT DOES NOT TOUCH app.js: it only reads the page (#log rows), so the working translation
// code cannot be broken by it. The Gemini key is still each person's own, kept in their browser
// and never saved to the database.

import { GoogleGenAI } from "https://cdn.jsdelivr.net/npm/@google/genai@2.29.1/+esm";
import {
  renderMarkdown, filterByTimeRange, transcriptText, fmtTime, dateKey,
  notesPrompt, askPrompt, catchupPrompt, toRow, fromRow, pageAll,
} from "./notes-core.js?v=5";

// ---------- settings you may want to change ----------
// Supabase project settings. The "anon / publishable" key is MEANT to be public (it sits in browser
// code); the row-level-security rules in the database are what protect the data. NEVER put the
// secret / service_role key here.
const SUPABASE_URL = "https://pqwiwtaoxuwmmmkzbnnt.supabase.co";
const SUPABASE_KEY = "sb_publishable_yfQ8JtNB4i-xi8WP5OIbvQ_emos0d7-"; // public key: safe in a browser because row-level security protects the data
const CLOUD = /^https:\/\//.test(SUPABASE_URL) && !/^PASTE/.test(SUPABASE_KEY);

// Text model for notes/answers. This is the SAME model gemini.js uses for translation, so we know
// your key can use it. Google retires models over time: if you ever see a "404 / no longer available"
// message, change this one line to a current model name.
const MODEL = "gemini-3.5-flash-lite";
const KEY_NAME = "gemini_api_key"; // same localStorage key app.js uses
const POLL_MS = 4000;              // how often we look at the screen for new lines
const STABLE_MS = 6000;            // a line is "finished" once its text stops changing this long
const NOTES_EVERY_MS = 120000;     // make notes at most every 2 minutes
const PREV_NOTES_CHARS = 1500;     // how much old notes we show Gemini for continuity

const byId = (a, b) => a.id - b.id;

// =====================================================================================
// STORAGE ADAPTER 1: local (IndexedDB)
// Three "tables" (object stores):
//   sessions: one per class   {id, title, startedAt, endedAt}
//   chunks:   raw saved lines {id, sessionId, text, src, ts}   <- the full transcript
//   notes:    generated notes {id, sessionId, markdown, fromTs, toTs, toChunkId}
// =====================================================================================
let dbPromise = null;
function openLocalDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const open = indexedDB.open("class-notes", 1);
    open.onupgradeneeded = () => {
      const db = open.result;
      db.createObjectStore("sessions", { keyPath: "id", autoIncrement: true });
      db.createObjectStore("chunks", { keyPath: "id", autoIncrement: true }).createIndex("bySession", "sessionId");
      db.createObjectStore("notes", { keyPath: "id", autoIncrement: true }).createIndex("bySession", "sessionId");
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  return dbPromise;
}

const asPromise = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

async function run(name, mode, fn) {
  const db = await openLocalDb();
  const tx = db.transaction(name, mode);
  const result = await fn(tx.objectStore(name));
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  return result;
}

const local = {
  add: (kind, obj) => run(kind, "readwrite", (s) => asPromise(s.add(obj))),
  put: (kind, obj) => run(kind, "readwrite", (s) => asPromise(s.put(obj))),
  all: (kind) => run(kind, "readonly", (s) => asPromise(s.getAll())),
  async bySession(kind, id, afterId = 0) {
    const rows = await run(kind, "readonly", (s) => asPromise(s.index("bySession").getAll(id)));
    return rows.filter((r) => r.id > afterId).sort(byId);
  },
  // Delete one class AND everything that belongs to it in a single transaction: all or nothing.
  async deleteSession(id) {
    const db = await openLocalDb();
    const tx = db.transaction(["sessions", "chunks", "notes"], "readwrite");
    for (const name of ["chunks", "notes"]) {
      const s = tx.objectStore(name);
      const keys = await asPromise(s.index("bySession").getAllKeys(id));
      for (const key of keys) s.delete(key);
    }
    tx.objectStore("sessions").delete(id);
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  },
};

// =====================================================================================
// STORAGE ADAPTER 2: cloud (Supabase / Postgres)
// The page uses camelCase names (sessionId); the database uses snake_case (session_id). toRow /
// fromRow (in notes-core.js) translate between the two, and pageAll reads long classes page by
// page. We never send user_id: the database fills it in from the logged-in user (default
// auth.uid()), and the security rules only show you your own rows.
// =====================================================================================
let sb = null; // the Supabase client, created after the library loads
const TABLES = { sessions: "class_sessions", chunks: "class_chunks", notes: "class_notes" };

const cloud = {
  async add(kind, obj) {
    const { id, ...rest } = obj;
    const { data, error } = await sb.from(TABLES[kind]).insert(toRow(kind, rest)).select("id").single();
    if (error) throw error;
    return data.id;
  },
  async put(kind, obj) {
    const { id, ...rest } = obj;
    const { error } = await sb.from(TABLES[kind]).update(toRow(kind, rest)).eq("id", id);
    if (error) throw error;
  },
  async all(kind) {
    const rows = await pageAll((a, b) => sb.from(TABLES[kind]).select("*").order("id").range(a, b));
    return rows.map((r) => fromRow(kind, r));
  },
  async bySession(kind, sessionId, afterId = 0) {
    const rows = await pageAll((a, b) => sb.from(TABLES[kind]).select("*")
      .eq("session_id", sessionId).gt("id", afterId).order("id").range(a, b));
    return rows.map((r) => fromRow(kind, r));
  },
  // One delete is enough: the tables are linked with "on delete cascade", so removing the class
  // row makes the database remove its lines and notes too.
  async deleteSession(id) {
    const { error } = await sb.from(TABLES.sessions).delete().eq("id", id);
    if (error) throw error;
  },
};

// The rest of the file talks to "store", never to a specific database.
let store = local;
const dbAdd = (kind, obj) => store.add(kind, obj);
const dbPut = (kind, obj) => store.put(kind, obj);
const dbAll = (kind) => store.all(kind);
const dbBySession = (kind, id, afterId = 0) => store.bySession(kind, id, afterId);
const dbDeleteSession = (id) => store.deleteSession(id);

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
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return "Could not reach the server. Check your internet connection and try again.";
  if (/JWT|not authenticated|row-level security/i.test(msg)) return "Your sign-in expired. Use Account, then Sign out, and sign in again.";
  if (/404|NOT_FOUND|no longer available/i.test(msg)) return `The Gemini model "${MODEL}" is not available for your key. Change MODEL at the top of notes.js to a current model name.`;
  if (/429|quota|RESOURCE_EXHAUSTED|rate/i.test(msg)) return "Gemini's free limit is reached for now. Wait a minute and try again.";
  if (/API key|API_KEY|401|403|PERMISSION/i.test(msg)) return "There is a problem with your Gemini key. Check it in Settings.";
  return msg.slice(0, 200);
}

// ---------- the panel (injected into the page, so index.html barely changes) ----------
// Layout: a class picker, four tabs (Record / Notes / Ask / Catch up) and a status line that is always
// visible. Only the tab buttons and the "pane" sections are new; every control keeps its old id, so the
// logic further down does not care how things are arranged.
const css = document.createElement("style");
css.textContent = `
  #cn { margin-top: 24px; }
  #cn h2 { margin: 0 0 14px; font-size: 1.2rem; }
  #cn h3 { font-size: 1rem; margin: 18px 0 8px; }
  #cn h4, #cn h5, #cn h6 { margin: 12px 0 4px; }
  #cn ul { margin: 0 0 8px; padding-left: 20px; }
  #cn p { margin: 0 0 8px; }
  #cn .keyrow { align-items: center; margin-bottom: 10px; }
  #cn .box { border: 1px solid var(--line); border-radius: 12px; padding: 12px 16px; margin-top: 10px; background: var(--bg); }
  #cn .notes { max-height: min(60vh, 520px); overflow: auto; }
  #cn input[type=time], #cn input[type=email], #cn input[type=date] { font: inherit; color: var(--text);
    background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 9px 12px; min-width: 0; }
  #cn .inline { flex-direction: row; align-items: center; gap: 8px; }

  /* class picker + tabs */
  #cn .cn-bar { margin-bottom: 14px; }
  #cn .cn-tabs { display: flex; gap: 4px; padding: 4px; margin-bottom: 14px; background: var(--bg);
    border: 1px solid var(--line); border-radius: 14px; }
  #cn .cn-tabs button { flex: 1; min-height: 40px; padding: 8px 6px; border-radius: 10px; background: transparent;
    color: var(--muted); font-weight: 600; font-size: .95rem; white-space: nowrap; }
  @media (hover: hover) {
    #cn .cn-tabs button:hover:not([aria-selected=true]) { background: var(--accent-soft, transparent); filter: none; }
  }
  #cn .cn-tabs button[aria-selected=true] { background: var(--accent-soft, var(--panel)); color: var(--accent);
    box-shadow: inset 0 0 0 1px var(--accent); }
  #cn .cn-pane { margin-top: 4px; }
  #cn #cnStatus { min-height: 1.5em; margin: 12px 0 0; }
  #cn .cn-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
  #cn .cn-manage { margin-top: 16px; }
  #cn .cn-manage summary { cursor: pointer; font-weight: 600; padding: 6px 0; }
  #cn .cn-mrow { display: flex; gap: 10px; align-items: center; justify-content: space-between;
    padding: 8px 0; border-top: 1px solid var(--line); }
  #cn .cn-mrow span { overflow-wrap: anywhere; min-width: 0; }
  #cn .cn-mrow small { color: var(--muted); }
  #cn .cn-mrow button { flex: none; color: var(--error); }
  #cn .cn-catch { display: flex; flex-wrap: wrap; gap: 10px; align-items: end; }
  #cn .cn-catch label { flex: 1 1 150px; }
  #cn .cn-catch label input { width: 100%; }
  #cn .cn-catch button { flex: 0 0 auto; }

  /* Sign-in gate: a full-screen cover shown until the user is signed in */
  #cnGate { position: fixed; inset: 0; z-index: 1000; overflow: auto;
    background: radial-gradient(1200px 600px at 50% -10%, var(--accent-soft, transparent), transparent 70%), var(--bg);
    display: flex; align-items: center; justify-content: center; padding: 20px; }
  #cnGate .card { width: 100%; max-width: 460px; padding: clamp(22px, 5vw, 34px); text-align: center; }
  #cnGate .brand { width: 64px; height: 64px; border-radius: 16px; box-shadow: 0 6px 20px rgba(0,0,0,.2); }
  #cnGate h2 { font-size: 1.6rem; margin: 14px 0 4px; letter-spacing: -.02em; }
  #cnGate .tag-line { color: var(--muted); margin: 0 0 18px; }
  #cnGate ul { list-style: none; margin: 0 0 22px; padding: 0; text-align: left; display: grid; gap: 10px; }
  #cnGate li { display: flex; gap: 12px; align-items: flex-start; font-size: .95rem; }
  #cnGate li span.ic { flex: none; width: 32px; height: 32px; border-radius: 10px; display: grid; place-items: center;
    background: var(--accent-soft, var(--bg)); font-size: 1rem; }
  #cnGate li b { display: block; }
  #cnGate li small { color: var(--muted); font-size: .85rem; }
  #cnGate form, #cnGate .signin { display: flex; flex-direction: column; gap: 10px; text-align: left; }
  #cnGate input[type=email] { width: 100%; font: inherit; font-size: 1rem; color: var(--text); background: var(--panel);
    border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; min-width: 0; }
  #cnGate button { width: 100%; min-height: 48px; }
  #cnGate .note { text-align: center; margin: 12px 0 0; }

  /* Account button (top right, next to Settings) and its small menu */
  #cnAcct { position: relative; }
  #cnAcctBtn { max-width: 130px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #cnAcctBtn .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%;
    background: var(--level); margin-right: 6px; }
  #cnAcctMenu { position: absolute; right: 0; top: calc(100% + 8px); z-index: 50; width: min(280px, 86vw);
    background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 14px 16px;
    box-shadow: 0 10px 32px rgba(0,0,0,.28); }
  #cnAcctMenu p { margin: 0 0 8px; overflow-wrap: anywhere; }

  @media (max-width: 480px) {
    #cn .cn-tabs button { font-size: .85rem; padding: 8px 2px; }
    #cn .cn-actions button { flex: 1 1 calc(50% - 8px); }
    #cn .keyrow button { flex: 1 1 100%; }
    #cn .cn-catch button { flex: 1 1 100%; }
  }
`;
document.head.append(css);

const panel = document.createElement("section");
panel.id = "cn";
panel.className = "card";
panel.hidden = true;
panel.innerHTML = `
  <h2>Class notes</h2>

  <div id="cnMain" hidden>
    <p id="cnImport" class="note" hidden></p>
    <label class="cn-bar">Showing class <select id="cnSession"></select></label>

    <div class="cn-tabs" role="tablist">
      <button type="button" role="tab" data-tab="record" aria-selected="true">Record</button>
      <button type="button" role="tab" data-tab="notes" aria-selected="false">Notes</button>
      <button type="button" role="tab" data-tab="ask" aria-selected="false">Ask</button>
      <button type="button" role="tab" data-tab="catch" aria-selected="false">Catch up</button>
    </div>

    <div class="cn-pane" data-pane="record">
      <p class="note" id="cnIntro" style="margin-top:0">Just want translation? Ignore this box: nothing is saved until you press <b>Start recording notes</b>. For a Google Meet or Zoom call, choose type <b>Meeting</b>.</p>
      <label>Start as <select id="cnPick"></select></label>
      <div id="cnKindRow" style="margin-top:10px">
        <label>Type <select id="cnKind">
          <option value="class">Class (lecture notes)</option>
          <option value="meeting">Meeting (notes with decisions and action items)</option>
        </select></label>
      </div>
      <div class="keyrow" style="margin-top:10px">
        <input id="cnTitle" type="text" placeholder="Class title (optional)">
        <button id="cnStart">Start recording notes</button>
        <button id="cnEnd" class="secondary" hidden>End class</button>
      </div>
      <p id="cnMatch" class="note" hidden></p>
    </div>

    <div class="cn-pane" data-pane="notes" hidden>
      <div id="cnNotes" class="box notes note">No notes yet.</div>
      <div class="cn-actions">
        <button id="cnUpdate" class="secondary small">Update notes now</button>
        <button id="cnExport" class="secondary small">Download .md</button>
        <button id="cnRename" class="secondary small">Rename class</button>
        <button id="cnDelete" class="secondary small">Delete class</button>
      </div>
      <details id="cnManage" class="cn-manage">
        <summary>Manage all classes</summary>
        <div id="cnManageList"></div>
      </details>
    </div>

    <div class="cn-pane" data-pane="ask" hidden>
      <form id="cnAskForm" class="keyrow">
        <input id="cnQ" type="text" placeholder="Ask about this class, or anything related">
        <button type="submit">Ask</button>
      </form>
      <label class="inline"><input type="checkbox" id="cnAll"> Search all my classes</label>
      <div id="cnAnswer" class="box" hidden></div>
    </div>

    <div class="cn-pane" data-pane="catch" hidden>
      <p class="note">Zoned out? Pick the time window you missed and get a short summary of what was said.</p>
      <div class="cn-catch">
        <label>Day <input type="date" id="cnDate"></label>
        <label>From <input type="time" id="cnFrom"></label>
        <label>To <input type="time" id="cnTo"></label>
        <button id="cnCatch" class="secondary">Summarise</button>
      </div>
      <div id="cnCatchOut" class="box" hidden></div>
    </div>

    <p id="cnStatus" class="note"></p>
    <p id="cnUsage" class="note" style="margin:6px 0 0"></p>
  </div>
`;
document.querySelector("main").append(panel);
const $ = (id) => panel.querySelector("#" + id);

// Tabs: show one pane, hide the others. aria-selected keeps screen readers informed.
for (const tab of panel.querySelectorAll(".cn-tabs button")) {
  tab.onclick = () => {
    for (const t of panel.querySelectorAll(".cn-tabs button")) t.setAttribute("aria-selected", String(t === tab));
    for (const pane of panel.querySelectorAll(".cn-pane")) pane.hidden = pane.dataset.pane !== tab.dataset.tab;
  };
}

const setStatus = (text, bad = false) => { $("cnStatus").textContent = text; $("cnStatus").style.color = bad ? "var(--error)" : ""; };
function show(box, html) { box.hidden = false; box.innerHTML = html; }
const plain = (t) => `<p class="note">${t}</p>`;

// ---------- state ----------
let current = null;       // the class being recorded right now (null if none)
let busy = false;         // true while Gemini is writing notes (prevents two at once)
let lastNotesAt = Date.now();
let sessions = [];        // all saved classes, newest first
let userEmail = "";       // who is signed in (cloud mode)

// ---------- 1. capture lines from the screen ----------
// Live Translate keeps adding/updating ".row" elements inside #log. A row's ".dst" text is the
// translated line. While Gemini is still streaming, the text keeps changing, so we only save
// a row once its text has stayed the same for STABLE_MS. We tag rows with data-* attributes
// (cnSaved etc.) so we never save one twice.
//
// Saves go through a one-at-a-time queue. With an online database, saving lines in parallel could
// let a later line get an earlier id, and "notes cover everything up to id N" would skip it.
let saveQueue = Promise.resolve();
const enqueue = (fn) => (saveQueue = saveQueue.then(fn, fn));

let savedCount = 0; // lines saved in the class being recorded (shown in the status line)
async function saveRow(row, text) {
  if (!current) return; // the class was ended or deleted while this save was waiting in the queue
  row.dataset.cnSaved = "1";
  const src = row.querySelector(".src")?.textContent.trim() ?? "";
  try {
    await dbAdd("chunks", { sessionId: current.id, text, src, ts: Number(row.dataset.cnT) || Date.now() });
  } catch (err) {
    delete row.dataset.cnSaved; // not saved: try this line again on the next check
    throw err;
  }
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
    if (text && !isErrorLine(text) && (stable || force)) jobs.push(enqueue(() => saveRow(row, text)));
  }
  return Promise.all(jobs);
}

setInterval(async () => {
  // Show our panel only when the main translate screen is visible (not on the key setup screen).
  // Online mode: the notes are available as soon as you are signed in, even before a Gemini key is saved
  // or the translator is open, so you can just read old notes. Device-only mode keeps the old rule.
  panel.hidden = store === cloud ? !activeUserId : (document.getElementById("app")?.hidden ?? true);
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
    const notes = (await dbBySession("notes", session.id)).sort(byId);
    const doneUntil = notes.at(-1)?.toChunkId ?? 0;
    const fresh = (await dbBySession("chunks", session.id, doneUntil)).sort(byId);
    if (!fresh.length) {
      // Say WHY nothing happened, instead of staying silent.
      if (manual) {
        setStatus(notes.length
          ? "All saved lines are already in the notes. Say or type something new."
          : "No lines saved in this class yet. Press Start recording notes FIRST, then speak or type; lines typed before Start class are ignored.", true);
      }
      return;
    }
    setStatus("Writing notes…");
    const previous = notes.map((n) => n.markdown).join("\n\n").slice(-PREV_NOTES_CHARS);
    let markdown = await askGemini(notesPrompt(transcriptText(fresh), previous, session.kind));
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
  try {
    if (pick === "new") {
      const started = Date.now();
      const kind = $("cnKind").value === "meeting" ? "meeting" : "class";
      const title = $("cnTitle").value.trim()
        || `${kind === "meeting" ? "Meeting" : "Class"} ${new Date(started).toLocaleDateString()}`;
      const id = await dbAdd("sessions", { title, kind, startedAt: started, endedAt: null });
      current = { id, title, kind, startedAt: started, endedAt: null };
    } else {
      // CONTINUE a previous class: reuse the same session, so new lines and new notes are
      // added to it. Its old transcript and notes stay untouched, and the last notes are shown
      // to Gemini for continuity (see makeNotes).
      current = sessions.find((s) => s.id === Number(pick));
      current.endedAt = null;
      await dbPut("sessions", current);
    }
  } catch (err) { current = null; setStatus(friendly(err), true); return; }
  lastNotesAt = Date.now();
  savedCount = 0;
  // A meeting needs the tab's sound too, so switch the Audio source for the person (only if this browser can share tab audio).
  const src = document.getElementById("audioSource");
  if (current.kind === "meeting" && src && !src.querySelector('option[value="meeting"]')?.disabled && src.value !== "meeting") {
    src.value = "meeting"; src.dispatchEvent(new Event("change", { bubbles: true }));
  }
  $("cnStart").hidden = true; $("cnEnd").hidden = false; $("cnTitle").disabled = true; $("cnPick").disabled = true;
  setStatus(pick === "new"
    ? `Started a NEW class "${current.title}". Now press Start listening above${current.kind === "meeting" ? " and pick the Meet/Zoom tab, ticking Also share tab audio" : ""}. Lines are saved automatically.`
    : `CONTINUING "${current.title}" (first started at ${fmtTime(current.startedAt)}). New lines and notes are added to it.`);
  await refresh(current.id);
};

// Picking an existing class hides the title box (the title already exists).
$("cnPick").onchange = () => { $("cnTitle").hidden = $("cnPick").value !== "new"; checkSameName(); };

// Same-name check. If you type a title that matches a class you already have, we do NOT silently make a
// second copy. We tell you and offer one click to add to the old class (the same thing as picking
// "Continue: ..." in the list). Pressing Start class anyway still makes a separate class.
function checkSameName() {
  $("cnKindRow").hidden = $("cnPick").value !== "new"; // the type is only chosen for a NEW class
  $("cnKind").disabled = $("cnPick").disabled;          // locked while a class is being recorded
  const box = $("cnMatch");
  const wanted = $("cnTitle").value.trim().toLowerCase();
  const hit = $("cnPick").value === "new" && wanted
    ? sessions.find((s) => s.title.trim().toLowerCase() === wanted)
    : null;
  if (!hit) { box.hidden = true; return; }
  const when = `${new Date(hit.startedAt).toLocaleDateString()} ${fmtTime(hit.startedAt)}`;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "secondary small";
  btn.textContent = "Add to that class";
  btn.onclick = () => {
    $("cnPick").value = String(hit.id);
    $("cnTitle").value = "";
    $("cnPick").onchange(); // hides the title box and clears this message
  };
  box.replaceChildren(
    document.createTextNode(`You already have a class called "${hit.title}" (${when}). `), btn,
    document.createTextNode(" Or press Start class to make a separate one."),
  );
  box.hidden = false;
}
$("cnTitle").addEventListener("input", checkSameName);

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
  } catch (err) {
    setStatus(friendly(err), true);
  } finally {
    $("cnStart").hidden = false; $("cnEnd").hidden = true; $("cnEnd").disabled = false;
    $("cnTitle").disabled = false; $("cnPick").disabled = false;
    $("cnTitle").value = "";
    $("cnPick").value = "new"; // next time starts a fresh class unless you choose to continue one
    checkSameName();           // clears the "you already have a class with this name" message
    await refresh(session.id).catch(() => {});
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
  // A class is shown by the NAME you gave it. The date and time are added only when two classes share
  // the same name, so you can still tell those apart.
  const titleCount = new Map();
  for (const s of sessions) {
    const k = s.title.trim().toLowerCase();
    titleCount.set(k, (titleCount.get(k) ?? 0) + 1);
  }
  const label = (s) => titleCount.get(s.title.trim().toLowerCase()) > 1
    ? `${s.title} · ${new Date(s.startedAt).toLocaleDateString()} ${fmtTime(s.startedAt)}`
    : s.title;
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
  // "Manage all classes": one row per class with its own Delete button.
  $("cnManageList").replaceChildren(...sessions.map((s) => {
    const row = document.createElement("div");
    row.className = "cn-mrow";
    const name = document.createElement("span");
    name.textContent = label(s);
    if (!s.endedAt) { // still open (recording, or waiting to be resumed)
      const tag = document.createElement("small");
      tag.textContent = " · not ended";
      name.append(tag);
    }
    const del = document.createElement("button");
    del.type = "button";
    del.className = "secondary small";
    del.textContent = "Delete";
    del.onclick = () => deleteClass(s.id);
    row.append(name, del);
    return row;
  }));
  if (!sessions.length) $("cnManageList").replaceChildren(Object.assign(document.createElement("p"), { className: "note", textContent: "No classes yet." }));
  checkSameName(); // also shows/hides the Type choice to match the "Start as" picker
  showUsage();
  await showNotes();
}

// Cloud mode: who is signed in. Local mode: how much browser storage is used.
async function showUsage() {
  if (store === cloud) {
    $("cnUsage").textContent = `Signed in as ${userEmail}. Notes are saved to your online account.`;
    return;
  }
  try {
    const { usage, quota } = await navigator.storage.estimate();
    const mb = (n) => (n / 1048576).toFixed(n < 10485760 ? 2 : 0);
    $("cnUsage").textContent = `Saved on this device only. Storage used: ${mb(usage)} MB of about ${mb(quota)} MB available.`;
  } catch { $("cnUsage").textContent = "Saved on this device only."; }
}

async function notesFor(id) {
  return (await dbBySession("notes", id)).sort(byId);
}

async function showNotes() {
  const id = Number($("cnSession").value);
  if (!id) { show($("cnNotes"), plain("No classes yet. Press Start recording notes.")); return; }
  const notes = await notesFor(id);
  show($("cnNotes"), notes.length
    ? renderMarkdown(notes.map((n) => n.markdown).join("\n\n"))
    : plain("Notes appear here a couple of minutes after the teacher starts talking."));
}
$("cnSession").onchange = () => showNotes().catch((err) => setStatus(friendly(err), true));

$("cnExport").onclick = async () => {
  const id = Number($("cnSession").value);
  const session = sessions.find((s) => s.id === id);
  if (!session) return;
  try {
    const notes = await notesFor(id);
    const md = `# ${session.title}\n\n_${new Date(session.startedAt).toLocaleString()}_\n\n`
      + (notes.map((n) => n.markdown).join("\n\n") || "(no notes yet)");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([md], { type: "text/markdown" }));
    link.download = `${session.title.replace(/[^\w\- ]+/g, "").trim() || "class-notes"}.md`;
    link.click();
    URL.revokeObjectURL(link.href);
  } catch (err) { setStatus(friendly(err), true); }
};

// ---------- rename / delete a class ----------
$("cnRename").onclick = async () => {
  const session = sessions.find((s) => s.id === Number($("cnSession").value));
  if (!session) return;
  const title = prompt("New name for this class:", session.title)?.trim();
  if (!title || title === session.title) return;
  try {
    session.title = title;
    if (current?.id === session.id) current.title = title; // keep the live recording in sync
    await dbPut("sessions", session);
    await refresh(session.id);
  } catch (err) { setStatus(friendly(err), true); }
};

// Delete ANY class (from the Delete class button or the "Manage all classes" list). We always ask first,
// because it cannot be undone. A class that is still recording can be deleted too: recording stops first.
async function deleteClass(id) {
  const session = sessions.find((s) => s.id === id);
  if (!session) return;
  const live = current?.id === id;
  const warning = live ? "It is still recording, so recording will stop. " : "";
  if (!confirm(`Delete "${session.title}"? ${warning}Its notes and saved transcript will be removed. This cannot be undone.`)) return;
  try {
    if (live) {
      current = null; // stops the capture loop from saving into this class
      $("cnStart").hidden = false; $("cnEnd").hidden = true; $("cnEnd").disabled = false;
      $("cnTitle").disabled = false; $("cnPick").disabled = false; $("cnTitle").value = "";
    }
    // Let any save or note-writing that is already in flight finish first, so nothing is written to a class
    // that no longer exists.
    await saveQueue.catch(() => {});
    while (busy) await new Promise((r) => setTimeout(r, 200));
    await dbDeleteSession(id);
    setStatus(`Deleted "${session.title}".`);
    await refresh(sessions.find((s) => s.id !== id)?.id);
    $("cnPick").value = "new";
    $("cnTitle").hidden = false;
    checkSameName();
  } catch (err) { setStatus(friendly(err), true); }
}
$("cnDelete").onclick = () => deleteClass(Number($("cnSession").value));

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
    const pending = await dbBySession("chunks", id, doneUntil);
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
  try {
    const chunks = filterByTimeRange(await dbBySession("chunks", id), from, to, $("cnDate").value);
    if (!chunks.length) { show($("cnCatchOut"), plain("No speech was saved between those times on that day.")); return; }
    show($("cnCatchOut"), plain("Summarising…"));
    show($("cnCatchOut"), renderMarkdown(await askGemini(catchupPrompt(transcriptText(chunks), from, to))));
  } catch (err) {
    show($("cnCatchOut"), plain(friendly(err)));
  }
};

// ---------- 6. sign in (cloud mode only) ----------
// Email "magic link" login: Supabase emails a link, clicking it opens this page again already signed in,
// and Supabase keeps them signed in on this browser (it stores the login session itself).
// (To use 6-digit codes instead, you need a custom email sender in Supabase; see the README notes.)
//
// 6a. THE GATE. In cloud mode a full-screen cover (#cnGate) is put over the whole app BEFORE we even
//     know if you are signed in, and `inert` on <main> stops clicks, typing and the Tab key from
//     reaching anything underneath. The cover is removed only once Supabase confirms a login.
//     Honest limit: this site is plain static files, so the gate is a front door, not a vault.
//     The real protection of your notes is in the database (row-level security: you only ever
//     see rows with your own user id). Nothing secret is behind the gate; the Gemini key is the
//     person's own and lives only in their browser.
let gate = null;
const g = (id) => gate.querySelector("#" + id);
const authMsg = (text, bad = false) => {
  if (!gate) return;
  g("cnAuthMsg").textContent = text;
  g("cnAuthMsg").style.color = bad ? "var(--error)" : "";
};

function buildGate() {
  gate = document.createElement("div");
  gate.id = "cnGate";
  gate.innerHTML = `
    <div class="card">
      <img class="brand" src="icons/icon-192.png" alt="">
      <h2>Live Translate</h2>
      <p class="tag-line">Understand any class, in real time.</p>
      <p id="cnGateLead" class="note">Checking your sign-in…</p>
      <div id="cnGateForm" hidden>
        <ul>
          <li><span class="ic">🎧</span><span><b>Live translation</b><small>Hear any language, read it in yours.</small></span></li>
          <li><span class="ic">📝</span><span><b>Automatic class notes</b><small>Structured notes written while the teacher talks.</small></span></li>
          <li><span class="ic">💬</span><span><b>Ask and catch up</b><small>Ask questions, or summarise the part you missed.</small></span></li>
        </ul>
        <div class="signin">
          <input id="cnEmail" type="email" placeholder="Your email" autocomplete="email" aria-label="Your email">
          <button id="cnSendCode">Email me a sign-in link</button>
        </div>
        <p id="cnAuthMsg" class="note">No password needed. Your notes are saved to your account, on any device.</p>
      </div>
    </div>`;
  document.body.append(gate);
  document.querySelector("main").inert = true;
  g("cnSendCode").onclick = sendLink;
  g("cnEmail").addEventListener("keydown", (e) => { if (e.key === "Enter") sendLink(); });
}
function showGateForm() { if (!gate) buildGate(); g("cnGateLead").hidden = true; g("cnGateForm").hidden = false; }
function openApp() { gate?.remove(); gate = null; document.querySelector("main").inert = false; }

// 6b. THE ACCOUNT BUTTON (top right, next to Settings): shows who is signed in, with a Sign out button.
const acct = document.createElement("div");
acct.id = "cnAcct";
acct.hidden = true; // shown only while signed in
acct.innerHTML = `
  <button id="cnAcctBtn" class="secondary small" type="button" aria-haspopup="true">Account</button>
  <div id="cnAcctMenu" hidden>
    <p class="note">Signed in as<br><b id="cnAcctEmail"></b></p>
    <p class="note">Your class notes are saved to your online account.</p>
    <p id="cnAcctMsg" class="note" style="color:var(--error)"></p>
    <button id="cnSignOut" class="secondary small" type="button">Sign out</button>
  </div>`;
{
  const header = document.querySelector("header");
  const settingsBtn = document.getElementById("settingsBtn");
  header.insertBefore(acct, settingsBtn?.parentNode === header ? settingsBtn : null);
}
const ac = (id) => acct.querySelector("#" + id);
ac("cnAcctBtn").onclick = (e) => {
  e.stopPropagation();
  ac("cnAcctMsg").textContent = "";
  ac("cnAcctMenu").hidden = !ac("cnAcctMenu").hidden;
};
document.addEventListener("click", (e) => { if (!acct.contains(e.target)) ac("cnAcctMenu").hidden = true; });

function authError(err) {
  const msg = String(err?.message ?? err);
  if (/rate limit|too many|429|seconds/i.test(msg)) return "Too many emails requested. Wait a few minutes and try again.";
  if (/not authorized|not allowed|invalid|expired|token/i.test(msg)) return "Could not send the sign-in email: " + msg.slice(0, 120);
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return "Could not reach the server. Check your internet connection.";
  return msg.slice(0, 200);
}

async function sendLink() {
  if (!sb) { authMsg("Still loading. Try again in a moment.", true); return; }
  const email = g("cnEmail").value.trim();
  if (!/^\S+@\S+\.\S+$/.test(email)) { authMsg("Enter a valid email address.", true); return; }
  g("cnSendCode").disabled = true;
  authMsg("Sending…");
  // emailRedirectTo = where the link brings the user back to (must be in Supabase's Redirect URLs list).
  const back = location.origin + location.pathname;
  const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: true, emailRedirectTo: back } });
  if (!gate) return; // signed in (maybe in another tab) while the email was being sent
  g("cnSendCode").disabled = false;
  if (error) { authMsg(authError(error), true); return; }
  authMsg(`We emailed a sign-in link to ${email}. Click it and you will be signed in (the link may open a new tab: this one signs in too). Check spam if it does not arrive.`);
  // Supabase shares the login between tabs of the same site, so onAuthStateChange (below) fires here too.
}

ac("cnSignOut").onclick = async () => {
  if (current) { ac("cnAcctMsg").textContent = "End the class before signing out."; return; }
  ac("cnAcctMenu").hidden = true;
  await sb.auth.signOut();
};

// Called whenever the login changes (page load, sign in, sign out). Only reacts to a real change of user.
// It starts as `undefined` (not null) so the very first call, even "nobody is signed in", is handled.
let activeUserId;
function applyUser(user) {
  const id = user?.id ?? null;
  if (id === activeUserId) return;
  activeUserId = id;
  current = null; sessions = [];
  if (!id) { // not signed in (first visit, or just signed out): cover the app and ask for an email
    acct.hidden = true;
    $("cnMain").hidden = true;
    ac("cnAcctMenu").hidden = true;
    showGateForm();
    return;
  }
  userEmail = user.email ?? "";
  openApp(); // removes the gate
  const dot = document.createElement("span");
  dot.className = "dot";
  ac("cnAcctBtn").replaceChildren(dot, document.createTextNode(userEmail.split("@")[0].slice(0, 16) || "Account"));
  ac("cnAcctEmail").textContent = userEmail;
  acct.hidden = false;
  $("cnMain").hidden = false;
  startApp();
}

// ---------- bring old classes into your account ----------
// Before sign-in existed, classes were saved only in this browser (IndexedDB, the "local" adapter). The
// button below copies them into your online account. Nothing is deleted from the browser: we only remember
// which old classes were already copied (per account) so the button does not offer them twice.
const importedKey = () => `cn_imported_${activeUserId}`;
function importedIds() {
  try { return JSON.parse(localStorage.getItem(importedKey()) || "[]"); } catch { return []; }
}

// Copy ONE old class (its lines and its notes). Old line ids are mapped to the new ids, because each
// note remembers "the last line I covered" (toChunkId). If anything fails half-way, the half-copied class is
// removed again (deleting the class row removes its lines and notes), so a retry never makes duplicates.
async function importOne(s) {
  const newId = await cloud.add("sessions", {
    title: s.title, kind: s.kind ?? "class", startedAt: s.startedAt, endedAt: s.endedAt ?? s.startedAt,
  });
  try {
    const idMap = new Map();
    for (const c of await local.bySession("chunks", s.id)) {
      idMap.set(c.id, await cloud.add("chunks", { sessionId: newId, text: c.text, src: c.src ?? "", ts: c.ts }));
    }
    const lastNew = Math.max(0, ...idMap.values());
    for (const n of await local.bySession("notes", s.id)) {
      await cloud.add("notes", {
        sessionId: newId, markdown: n.markdown, fromTs: n.fromTs, toTs: n.toTs,
        toChunkId: idMap.get(n.toChunkId) ?? lastNew,
      });
    }
  } catch (err) {
    await cloud.deleteSession(newId).catch(() => {});
    throw err;
  }
}

async function offerImport() {
  const box = $("cnImport");
  box.hidden = true;
  if (store !== cloud) return;
  let old = [];
  try { old = await local.all("sessions"); } catch { return; }
  const done = new Set(importedIds());
  const todo = old.filter((s) => !done.has(s.id)).sort(byId);
  if (!todo.length) return;
  const plural = `class${todo.length === 1 ? "" : "es"}`;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "secondary small";
  btn.textContent = `Import ${todo.length} old ${plural}`;
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      for (const [i, s] of todo.entries()) {
        box.firstChild.textContent = `Importing ${i + 1} of ${todo.length}… `;
        await importOne(s);
        try { localStorage.setItem(importedKey(), JSON.stringify([...importedIds(), s.id])); } catch { /* storage blocked */ }
      }
      setStatus(`Imported ${todo.length} old ${plural} into your account.`);
      await refresh();
      await offerImport();
    } catch (err) {
      btn.disabled = false;
      setStatus(friendly(err), true);
    }
  };
  box.replaceChildren(
    document.createTextNode(`Found ${todo.length} ${plural} saved on this device from before you signed in. `), btn,
  );
  box.hidden = false;
}

// ---------- on page load ----------
async function startApp() {
  setStatus(`Press Start recording notes, then Start listening above. Notes are saved ${store === cloud ? "to your online account" : "on this device"}.`);
  try {
    await refresh();
    offerImport();
    // A class stays ONE class until you press End class. If the page was closed or reloaded in the
    // middle of one, we pick it up again instead of ending it or starting a new one. (If several are
    // unfinished, the newest is resumed and the older ones are ended, since you moved on from them.)
    const open = sessions.filter((x) => !x.endedAt); // newest first
    for (const old of open.slice(1)) {
      const last = (await dbBySession("chunks", old.id)).at(-1);
      old.endedAt = last?.ts ?? old.startedAt;
      await dbPut("sessions", old);
      if (last) makeNotes(old); // errors are shown in the status line
    }
    if (open.length && !current) await resumeClass(open[0]);
    // Nothing to resume and you have classes? You are probably here to read notes: open the Notes tab.
    else if (sessions.length && !current) panel.querySelector('[data-tab="notes"]').click();
  } catch (err) { setStatus(friendly(err), true); }
}

// Re-enter "recording" mode for a class that was never ended (same screen as after pressing Start class).
async function resumeClass(session) {
  current = session;
  lastNotesAt = Date.now();
  savedCount = 0;
  document.querySelectorAll("#log .row").forEach((r) => { r.dataset.cnSaved = "1"; }); // old rows are not new speech
  $("cnStart").hidden = true; $("cnEnd").hidden = false; $("cnTitle").disabled = true; $("cnPick").disabled = true;
  $("cnTitle").hidden = true;
  setStatus(`"${session.title}" is still open (you did not press End class). Press Start listening above to keep adding to it, or End class when it is over.`);
  await refresh(session.id);
}

if (CLOUD) buildGate(); // cover the app right away, before we know whether anyone is signed in

(async function boot() {
  if (!CLOUD) { // no Supabase settings: keep notes in this browser only (no accounts)
    store = local;
    $("cnMain").hidden = false;
    startApp();
    return;
  }
  // If the emailed link was expired or already used, Supabase puts the reason in the address (#error_description=...).
  const linkError = new URLSearchParams(location.hash.slice(1)).get("error_description");
  try {
    // Loaded only now, and only in cloud mode, so a CDN problem cannot break the rest of the page.
    const { createClient } = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm");
    sb = createClient(SUPABASE_URL, SUPABASE_KEY);
  } catch {
    showGateForm();
    authMsg("Could not load the sign-in library. Check your internet connection and reload.", true);
    return;
  }
  store = cloud;
  const { data } = await sb.auth.getSession(); // also picks up a login that arrived through the emailed link
  applyUser(data.session?.user ?? null);
  if (linkError && !data.session) authMsg(linkError.replace(/\+/g, " ") + " Send a new link below.", true);
  sb.auth.onAuthStateChange((_event, session) => applyUser(session?.user ?? null));
})();
