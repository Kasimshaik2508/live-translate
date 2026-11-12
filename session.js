// session.js — one "class session" that runs Live translation and Class notes together.
//
// Translation (app.js) and notes (notes.js) still work on their own. This file only presses their
// existing controls (#toggle starts/stops listening, #cnStart/#cnEnd start/end notes) and watches their
// state, so a session can use either feature, or both, and switch each one on or off mid-class.
//
//   - Notes are written from the translated lines, so the microphone runs while the session is on and
//     at least one feature is on.
//   - Switching translation off only hides the captions; while notes are recording, listening goes on.
//   - End class session stops listening, saves the last lines, writes the final notes and ends the class.

const $ = (id) => document.getElementById(id);
const mic = $("toggle");                 // app.js's Start/Stop listening button (hidden)
const btn = $("sessionBtn");
const resume = $("resumeBtn");
const chips = { translate: $("featTranslate"), notes: $("featNotes") };

const want = { translate: true, notes: true }; // what the next session runs (chosen before Start)
let active = false;                             // a session is running
let captions = true;                            // translation shown on screen during the session
let notesBusy = false;                          // notes are starting or ending (async database work)
let pausedClass = "";                           // class whose notes were switched off mid-session

try { Object.assign(want, JSON.parse(localStorage.getItem("session_features") || "{}")); } catch { /* storage blocked */ }
const remember = () => { try { localStorage.setItem("session_features", JSON.stringify(want)); } catch { /* storage blocked */ } };

const micLive = () => mic.classList.contains("live");
const notesAvailable = () => !!$("cnStart") && !$("cnMain").hidden && !$("cn").hidden;
const notesOn = () => !!$("cnEnd") && !$("cnEnd").hidden;
const micNeeded = () => active && (captions || notesOn());
const say = (text) => { $("sessionMsg").textContent = text; $("sessionMsg").hidden = !text; };
const until = async (test, ms = 10000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 150))) if (test()) return true;
  return test();
};

async function startNotes() {
  if (notesOn() || !notesAvailable()) return notesOn();
  notesBusy = true; render();
  // Notes switched back on in the same session continue the same class instead of starting a new one.
  if (active && pausedClass && [...$("cnPick").options].some((o) => o.value === pausedClass)) {
    $("cnPick").value = pausedClass;
    $("cnPick").onchange?.();
  }
  $("cnStart").click();
  const ok = await until(notesOn);
  notesBusy = false;
  if (!ok) say("Class notes could not start. The Class notes panel says why.");
  return ok;
}

async function endNotes() {
  if (!notesOn()) return;
  notesBusy = true; render();
  pausedClass = active ? $("cnSession").value : "";
  $("cnEnd").click();                   // saves the last lines, writes the final notes, ends the class
  await until(() => !notesOn(), 30000);
  notesBusy = false;
}

const startMic = () => { if (!micLive() && !mic.disabled) mic.click(); };
const stopMic = () => { if (micLive()) mic.click(); };

async function startSession() {
  if (!want.translate && !want.notes) return;
  active = true;
  captions = want.translate;
  say("");
  // Notes first: a Meeting-type class switches the audio source, which would restart a running microphone.
  if (want.notes && !(await startNotes()) && !captions) { active = false; render(); return; }
  startMic();
  render();
}

async function endSession() {
  const hadNotes = notesOn();
  active = false;
  pausedClass = "";
  stopMic();
  await endNotes(); // marks notes busy before anything re-renders, so the open class is not seen as "resumed"
  say(hadNotes ? "Class session ended. Translation stopped and your notes are saved." : "");
  render();
}

// Switching one feature off never touches the other; switching the last one off ends the session.
async function flip(feature) {
  if (!active) {
    want[feature] = !want[feature];
    remember();
    return render();
  }
  if (feature === "translate") {
    captions = !captions;
    say(!captions && notesOn() ? "Captions hidden. Still listening, so notes keep recording." : "");
  } else if (notesOn()) {
    await endNotes();
    say("Notes stopped and saved. Translation keeps running.");
  } else {
    if (await startNotes()) say("Notes are recording. Translation keeps running.");
  }
  if (!captions && !notesOn()) return endSession();
  if (micNeeded()) startMic();
  render();
}

function setChip(chip, on, state) {
  chip.setAttribute("aria-pressed", String(on));
  chip.querySelector("small").textContent = state;
  chip.classList.toggle("recording", active && on);
}

function render() {
  // A class left open from before a reload (notes.js resumes it) counts as a running session.
  if (!active && notesOn() && !notesBusy) { active = true; captions = true; }
  const notes = notesOn();
  document.body.classList.toggle("captions-off", active && !captions);

  if (active) {
    setChip(chips.translate, captions, captions ? "Showing captions" : "Captions hidden");
    setChip(chips.notes, notes, notesBusy ? "Saving…" : notes ? "Recording" : "Off · tap to record");
  } else {
    setChip(chips.translate, want.translate, want.translate ? "On" : "Off");
    setChip(chips.notes, want.notes && notesAvailable(), notesAvailable() ? (want.notes ? "On" : "Off") : "Not available yet");
  }
  chips.notes.disabled = notesBusy || (!notesAvailable() && !notes);

  const withNotes = active ? notes : want.notes && notesAvailable();
  btn.classList.toggle("live", active);
  btn.disabled = notesBusy || (!active && (!(want.translate || withNotes) || mic.disabled));
  btn.textContent = active
    ? (withNotes ? "End class session" : "Stop translating")
    : want.translate && withNotes ? "Start class session"
      : withNotes ? "Start recording notes"
        : want.translate ? "Start translating" : "Choose what to run";
  resume.hidden = !(micNeeded() && !micLive());
}

btn.onclick = () => (active ? endSession() : startSession());
resume.onclick = () => startMic();
chips.translate.onclick = () => flip("translate");
chips.notes.onclick = () => flip("notes");

// Keep the buttons in step with app.js and notes.js: the microphone stopping on its own (an error, a locked
// screen), or notes being started/ended from elsewhere (a resumed class, a deleted class).
const watch = new MutationObserver(() => {
  if (active && !captions && !notesOn() && !notesBusy) { endSession(); return; } // nothing left to listen for
  render();
});
watch.observe(mic, { attributes: true, attributeFilter: ["class", "disabled"] });
for (const id of ["cnEnd", "cnMain", "cn"]) watch.observe($(id), { attributes: true, attributeFilter: ["hidden"] });
render();
