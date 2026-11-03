// notes-core.js — the "pure logic" of the Class Notes add-on.
//
// WHY a separate file: these functions only take text/numbers in and give text/numbers
// out. They never touch the page, the database or Gemini. That makes them easy to test
// (we run them in Node) and easy to explain: this file = "what we ask Gemini and how we
// slice/format text"; notes.js = "how it plugs into the app".

// ---------- small text helpers ----------

export function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Gemini replies in Markdown (## headings, - bullets, **bold**). The page shows HTML, so we
// convert a small subset. We ESCAPE first so nothing Gemini (or a teacher's words) says can
// inject HTML/JS into the page — this is a basic XSS protection step.
export function renderMarkdown(md) {
  const lines = escapeHtml(md).split("\n");
  const inline = (s) => s.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`(.+?)`/g, "<code>$1</code>");
  let html = "";
  let inList = false;
  const closeList = () => { if (inList) { html += "</ul>"; inList = false; } };
  for (const raw of lines) {
    const line = raw.trimEnd();
    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)/))) {
      closeList();
      const level = Math.min(m[1].length + 2, 6); // "#" -> h3 so it sits under the card title
      html += `<h${level}>${inline(m[2])}</h${level}>`;
    } else if ((m = line.match(/^\s*[-*•]\s+(.*)/))) {
      if (!inList) { html += "<ul>"; inList = true; }
      html += `<li>${inline(m[1])}</li>`;
    } else if (!line.trim()) {
      closeList();
    } else {
      closeList();
      html += `<p>${inline(line)}</p>`;
    }
  }
  closeList();
  return html;
}

// ---------- time helpers (for "what did I miss between 10:15 and 10:40") ----------

const pad = (n) => String(n).padStart(2, "0");

// "10:15" -> 615 (minutes since midnight). Returns null if it isn't a valid HH:MM.
export function hhmmToMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
}

export function minutesOfDay(ts) {
  const d = new Date(ts);
  return d.getHours() * 60 + d.getMinutes();
}

export function fmtTime(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// "2026-11-03" in the device's local time. Used to tell apart days of the same class.
export function dateKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Keep only the saved lines whose time of day falls inside [from, to] (inclusive).
// WHY the optional date: a class can now continue over several days ("Continue a previous
// class"), and 10:15 on Monday is not 10:15 on Tuesday. With a date, we only look at that day.
export function filterByTimeRange(chunks, fromHHMM, toHHMM, date = "") {
  const from = hhmmToMinutes(fromHHMM), to = hhmmToMinutes(toHHMM);
  if (from === null || to === null || from > to) return [];
  return chunks.filter((c) => {
    if (date && dateKey(c.ts) !== date) return false;
    const m = minutesOfDay(c.ts);
    return m >= from && m <= to;
  });
}

// Turn saved lines into "[10:15] text" lines — the timestamp helps Gemini (and us) place things.
export function transcriptText(chunks) {
  return chunks.map((c) => `[${fmtTime(c.ts)}] ${c.text}`).join("\n");
}

// ---------- database helpers (used by the online/Supabase storage) ----------

// The page uses camelCase names (sessionId); the database uses snake_case (session_id).
// COLS lists only the names that differ; toRow / fromRow translate in each direction.
export const COLS = {
  sessions: { startedAt: "started_at", endedAt: "ended_at" },
  chunks: { sessionId: "session_id" },
  notes: { sessionId: "session_id", fromTs: "from_ts", toTs: "to_ts", toChunkId: "to_chunk_id" },
};

export const toRow = (kind, obj) =>
  Object.fromEntries(Object.entries(obj).map(([k, v]) => [COLS[kind][k] ?? k, v]));

// Also drops user_id: the page never needs it (the database fills it in and filters by it).
export function fromRow(kind, row) {
  const back = Object.fromEntries(Object.entries(COLS[kind]).map(([js, db]) => [db, js]));
  const out = {};
  for (const [k, v] of Object.entries(row)) if (k !== "user_id") out[back[k] ?? k] = v;
  return out;
}

// The database returns at most 1000 rows per request, and a long class has more lines than that.
// So we ask page by page (1000 at a time) until a page comes back short.
// buildQuery(from, to) must return a promise of { data, error }.
export async function pageAll(buildQuery, size = 1000) {
  const rows = [];
  for (let from = 0; ; from += size) {
    const { data, error } = await buildQuery(from, from + size - 1);
    if (error) throw error;
    rows.push(...data);
    if (data.length < size) return rows;
  }
}

// ---------- the prompts (this is the "brain" of the agent) ----------

// 1) Live notes. We pass the tail of the previous notes so Gemini continues under the same
//    headings instead of starting over every 2 minutes.
// `kind` is "class" (default) or "meeting": a meeting gets decisions and action items instead of
// definitions and homework. Everything else (continuity, "only what was said") is identical.
export function notesPrompt(newTranscript, previousNotesTail = "", kind = "class") {
  const meeting = kind === "meeting";
  const setting = meeting ? "meeting" : "class";
  const speaker = meeting ? "the people in the meeting" : "the teacher";
  const focus = meeting
    ? `- Include key points, numbers, dates and names that were mentioned. Add a "### Decisions" list and a "### Action items" list (who and by when, only if they were said) ONLY if decisions or tasks were actually stated.`
    : `- Include definitions, formulas, examples and any homework / deadlines / exam hints the teacher mentions (put those under "### To do" only if actually mentioned).`;
  return `You are a careful note-taker sitting in a live ${setting}.
Below is the newest part of the ${setting} transcript (speech converted to text and translated, one line per phrase, prefixed with the time). It may have recognition or translation mistakes.

Write concise ${meeting ? "meeting" : "study"} notes in English, in Markdown.

Rules:
- Group by topic using "##" headings, then short bullet points. Bold the key terms.
${focus}
- Write ONLY what ${speaker} actually said. Do not add outside knowledge and do not invent anything.
- Skip small talk and repeated filler.
- If the topic continues from the previous notes, continue under the same heading name instead of repeating the whole heading.
- Output only the notes, nothing else.

${previousNotesTail ? `PREVIOUS NOTES (for continuity, do not repeat them):\n${previousNotesTail}\n\n` : ""}NEW TRANSCRIPT:
${newTranscript}`;
}

// 2) Questions. Two labelled sections so the student always knows what the TEACHER said
//    versus what the AI is adding from general knowledge.
export function askPrompt(classContext, question) {
  return `You are a study assistant for a student. Below are the notes taken in their class(es) or meeting(s). The student was sometimes distracted and missed parts, so the notes may be incomplete.

Answer the student's question using this exact structure:

**From class**
What the notes say about this. If the class notes do not cover it, say so plainly in one line. Never present anything here that is not in the notes.

**Beyond the class**
Extra explanation from general knowledge that helps answer the question. This part was NOT said in class — keep it clearly separate, accurate and short.

Keep the whole answer clear and concise.

CLASS NOTES:
${classContext || "(no notes saved yet)"}

QUESTION: ${question}`;
}

// 3) Catch-up for a time window.
export function catchupPrompt(transcript, fromHHMM, toHHMM) {
  return `A student was not listening between ${fromHHMM} and ${toHHMM} in class. Below is the saved transcript from that window (translated to text, may contain small errors).

Summarise what was taught, in English, as short bullet points in the order it happened. Use only what is in the transcript. End with one line starting "Review:" naming the most important thing to go back to.

TRANSCRIPT:
${transcript}`;
}
