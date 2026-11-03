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

// ---------- the prompts (this is the "brain" of the agent) ----------

// 1) Live notes. We pass the tail of the previous notes so Gemini continues under the same
//    headings instead of starting over every 2 minutes.
export function notesPrompt(newTranscript, previousNotesTail = "") {
  return `You are a careful note-taker sitting in a live class.
Below is the newest part of the class transcript (speech converted to text and translated, one line per phrase, prefixed with the time). It may have recognition or translation mistakes.

Write concise study notes in English, in Markdown.

Rules:
- Group by topic using "##" headings, then short bullet points. Bold the key terms.
- Include definitions, formulas, examples and any homework / deadlines / exam hints the teacher mentions (put those under "### To do" only if actually mentioned).
- Write ONLY what the teacher actually said. Do not add outside knowledge and do not invent anything.
- Skip small talk and repeated filler.
- If the topic continues from the previous notes, continue under the same heading name instead of repeating the whole heading.
- Output only the notes, nothing else.

${previousNotesTail ? `PREVIOUS NOTES (for continuity, do not repeat them):\n${previousNotesTail}\n\n` : ""}NEW TRANSCRIPT:
${newTranscript}`;
}

// 2) Questions. Two labelled sections so the student always knows what the TEACHER said
//    versus what the AI is adding from general knowledge.
export function askPrompt(classContext, question) {
  return `You are a study assistant for a student. Below are the notes taken in their class(es). The student was sometimes distracted and missed parts, so the notes may be incomplete.

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
