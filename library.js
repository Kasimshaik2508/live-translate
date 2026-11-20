// library.js — the left navigation and the "Class notes" page (folders + chat about a class).
//
// WHAT IT DOES
//   1. A left sidebar (a bottom tab bar on phones) with two pages:
//        Class notes              — your classes in folders, and a chat to ask questions about each one
//        Live translation with class — the original screen (translation + recording)
//   2. The Class notes page: folder list on the left, and for the open class a summary card, quick
//      question chips (Summarize, Key points, Quiz me, What did I miss) and a chat.
//   3. "Continue recording" on a class jumps to the Live page with that class ready to continue.
//
// HOW IT FITS: notes.js owns the data (folders, classes, notes) and Gemini. It publishes a small set of
// functions as window.cnApi and fires a "cn-change" event whenever something changed. This file only
// calls those functions and redraws, so the recording code is not touched by the page design.

const A = () => window.cnApi;
const $ = (sel, root = document) => root.querySelector(sel);

// ---------- tiny helpers ----------
function h(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (k === "html") node.innerHTML = v;
    else node.setAttribute(k, v === true ? "" : v);
  }
  node.append(...kids.flat().filter((x) => x != null && x !== false));
  return node;
}
const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } },
};
const ICON = {
  notes: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg>',
  live: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15a3.5 3.5 0 0 0 3.5-3.5v-6a3.5 3.5 0 1 0-7 0v6A3.5 3.5 0 0 0 12 15z"/><path d="M18.5 11.5a6.5 6.5 0 0 1-13 0M12 18v3"/></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  spark: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.2 6.3L20.5 10.5l-6.3 2.2L12 19l-2.2-6.3L3.5 10.5l6.3-2.2z"/></svg>',
  chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
};
const icon = (name, cls = "") => h("span", { class: `lm-ic ${cls}`, "aria-hidden": "true", html: ICON[name] });

// ---------- styles ----------
const css = document.createElement("style");
css.textContent = `
  :root { --nav-w: 232px; --nav-h: 0px; }
  @media (min-width: 900px) { body { padding-left: var(--nav-w); } }
  @media (max-width: 899px) { :root { --nav-h: calc(64px + env(safe-area-inset-bottom)); } }
  main { padding-bottom: calc(48px + var(--dock-h) + var(--nav-h)) !important; }

  /* ---- sidebar / bottom bar ---- */
  #lmNav { position: fixed; z-index: 60; background: var(--panel); border: 0 solid var(--line); }
  #lmNav .lm-logo { display: flex; align-items: center; gap: 10px; padding: 4px 8px 18px; }
  #lmNav .lm-logo img { width: 36px; height: 36px; border-radius: 11px; box-shadow: 0 6px 16px var(--glow); }
  #lmNav .lm-logo b { font-size: 1.05rem; letter-spacing: -.02em; }
  #lmNav .lm-item { position: relative; width: 100%; justify-content: flex-start; gap: 12px; min-height: 52px; text-align: left;
    padding: 8px 12px; border-radius: 14px; background: transparent; color: var(--muted); font-weight: 650; line-height: 1.2; }
  #lmNav .lm-item small { display: block; font-weight: 500; font-size: .76rem; color: var(--muted); }
  #lmNav .lm-item .lm-ic { width: 22px; height: 22px; flex: none; }
  #lmNav .lm-item[aria-current=page] { background: var(--accent-soft); color: var(--accent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 45%, transparent); }
  #lmNav .lm-item[aria-current=page] small { color: var(--accent); opacity: .85; }
  #lmNav .lm-item.rec::after { content: ""; position: absolute; top: 10px; right: 12px; width: 9px; height: 9px;
    border-radius: 50%; background: var(--live); box-shadow: 0 0 0 4px color-mix(in srgb, var(--live) 25%, transparent); }
  @media (hover: hover) { #lmNav .lm-item:hover:not([aria-current=page]) { background: var(--soft); filter: none; } }
  @media (min-width: 900px) {
    #lmNav { top: 0; bottom: 0; left: 0; width: var(--nav-w); border-right-width: 1px; padding: max(20px, env(safe-area-inset-top)) 14px 20px;
      display: flex; flex-direction: column; gap: 6px; }
    #lmNav .lm-foot { margin-top: auto; padding: 8px; font-size: .78rem; color: var(--muted); }
    body > main > header img, body > main > header .brand small { display: none; }
  }
  @media (max-width: 899px) {
    #lmNav { left: 0; right: 0; bottom: 0; height: var(--nav-h); border-top-width: 1px; display: grid; grid-template-columns: 1fr 1fr;
      gap: 4px; padding: 6px max(10px, env(safe-area-inset-right)) env(safe-area-inset-bottom) max(10px, env(safe-area-inset-left));
      background: color-mix(in srgb, var(--panel) 92%, transparent); backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px); }
    #lmNav .lm-logo, #lmNav .lm-foot { display: none; }
    #lmNav .lm-item { flex-direction: column; justify-content: center; gap: 2px; min-height: 50px; padding: 4px; text-align: center; font-size: .8rem; }
    #lmNav .lm-item small { display: none; }
    #lmNav .lm-item.rec::after { top: 6px; right: calc(50% - 22px); }
    .dock { bottom: var(--nav-h) !important; padding-bottom: 12px !important; }
  }
  @media (max-width: 640px) { :root { --dock-h: 120px; } }

  /* ---- which page shows ---- */
  body[data-page=notes] #app, body[data-page=notes] #setup, body[data-page=notes] #cn, body[data-page=notes] #installHint { display: none !important; }
  body[data-page=live] #notesPage { display: none !important; }
  body[data-page=notes] main { max-width: 1280px; }
  @media (min-width: 1060px) {
    body[data-page=notes] main:has(#cn:not([hidden])) { display: block; }
  }

  /* ---- the Class notes page ---- */
  #notesPage { --lm-h: calc(100dvh - 96px); display: grid; grid-template-columns: 320px minmax(0, 1fr); gap: 18px; height: var(--lm-h); min-height: 480px; }
  .lm-col { min-height: 0; min-width: 0; display: flex; flex-direction: column; background: var(--panel); border: 1px solid var(--line);
    border-radius: var(--radius); box-shadow: var(--shadow); overflow: hidden; }
  .lm-ic { display: inline-grid; place-items: center; }
  .lm-ic svg { width: 100%; height: 100%; }

  /* left: library */
  .lm-libhead { display: flex; align-items: center; gap: 8px; padding: 16px 16px 8px; }
  .lm-libhead h2 { flex: 1; margin: 0; font-size: 1.1rem; }
  .lm-search { padding: 0 16px 10px; }
  .lm-search input { padding: 9px 14px; border-radius: 12px; font-size: .95rem; }
  .lm-list { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 8px 14px; overscroll-behavior: contain; }
  .lm-empty { padding: 22px 14px; text-align: center; color: var(--muted); font-size: .92rem; }
  .lm-group { margin-bottom: 4px; border-radius: 12px; }
  .lm-group.drop { background: var(--accent-soft); outline: 2px dashed var(--accent); outline-offset: -2px; }
  .lm-ghead { display: flex; align-items: center; gap: 6px; padding: 6px 4px 6px 8px; border-radius: 10px; cursor: pointer; user-select: none; }
  .lm-ghead .lm-ic.chev { width: 14px; height: 14px; color: var(--muted); transition: transform .15s; }
  .lm-group.open .lm-ghead .lm-ic.chev { transform: rotate(90deg); }
  .lm-ghead .lm-ic.fold { width: 18px; height: 18px; color: var(--accent); }
  .lm-ghead .lm-gname { flex: 1; min-width: 0; font-weight: 650; font-size: .93rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .lm-ghead .lm-count { font-size: .78rem; color: var(--muted); }
  .lm-label { padding: 10px 10px 4px; font-size: .74rem; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--muted); }
  .lm-more { min-height: 32px; width: 32px; padding: 0; border-radius: 10px; background: transparent; color: var(--muted); flex: none; }
  .lm-more .lm-ic { width: 18px; height: 18px; }
  @media (hover: hover) { .lm-more:hover:not(:disabled) { background: var(--soft); filter: none; } .lm-ghead:hover, .lm-item:hover { background: var(--soft); } }
  .lm-class { display: flex; align-items: center; gap: 4px; padding: 8px 4px 8px 10px; margin: 1px 0; border-radius: 12px; cursor: pointer; border: 1px solid transparent; }
  .lm-group .lm-class { margin-left: 18px; }
  .lm-class[aria-current=true] { background: var(--accent-soft); border-color: color-mix(in srgb, var(--accent) 40%, transparent); }
  .lm-class .lm-ctext { flex: 1; min-width: 0; }
  .lm-class .lm-ctitle { font-weight: 600; font-size: .94rem; line-height: 1.3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .lm-class .lm-cmeta { font-size: .76rem; color: var(--muted); }
  .lm-rec { color: var(--live); font-weight: 700; }
  .lm-rec::before { content: "● "; }
  .lm-class.dragging { opacity: .45; }

  /* right: the class */
  .lm-head { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--line); }
  .lm-head .lm-back { display: none; min-height: 40px; width: 40px; padding: 0; background: transparent; color: var(--text); border: 1px solid var(--line); flex: none; }
  .lm-head .lm-back .lm-ic { width: 20px; height: 20px; }
  .lm-htext { flex: 1; min-width: 0; }
  .lm-htext h2 { margin: 0; font-size: 1.15rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .lm-htext small { color: var(--muted); font-size: .8rem; }
  .lm-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 16px; overscroll-behavior: contain; scroll-behavior: smooth; }
  .lm-inner { max-width: 760px; margin: 0 auto; display: flex; flex-direction: column; gap: 14px; }

  .lm-summary { border: 1px solid var(--line); border-radius: 18px; background: var(--soft); overflow: hidden; }
  .lm-sumhead { display: flex; align-items: center; gap: 8px; padding: 12px 14px 0; }
  .lm-sumhead b { flex: 1; font-size: .78rem; letter-spacing: .06em; text-transform: uppercase; color: var(--accent); }
  .lm-sumbody { position: relative; padding: 6px 16px 14px; max-height: 15rem; overflow: hidden; }
  .lm-summary.open .lm-sumbody { max-height: none; }
  .lm-summary:not(.open) .lm-sumbody.clip::after { content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 64px;
    background: linear-gradient(transparent, var(--soft)); pointer-events: none; }
  .lm-sumbody h3 { font-size: 1.02rem; margin: 14px 0 6px; } .lm-sumbody h4, .lm-sumbody h5, .lm-sumbody h6 { margin: 12px 0 4px; }
  .lm-sumbody h3:first-child, .lm-sumbody h4:first-child { margin-top: 8px; }
  .lm-sumbody ul { margin: 0 0 8px; padding-left: 20px; } .lm-sumbody p { margin: 0 0 8px; }
  .lm-sumfoot { display: flex; justify-content: center; padding: 0 12px 12px; }
  .lm-sumbody .lm-none { color: var(--muted); font-size: .93rem; margin: 10px 0 4px; }

  .lm-chips { display: flex; flex-wrap: wrap; gap: 8px; }
  .lm-chip { min-height: 38px; padding: 6px 14px; border-radius: 999px; background: var(--panel); color: var(--text);
    border: 1px solid var(--line); font-weight: 600; font-size: .9rem; }
  .lm-chip .lm-ic { width: 16px; height: 16px; color: var(--accent); }
  @media (hover: hover) { .lm-chip:hover:not(:disabled) { background: var(--accent-soft); border-color: var(--accent); filter: none; } }

  .lm-msgs { display: flex; flex-direction: column; gap: 16px; }
  .lm-u { align-self: flex-end; max-width: 85%; padding: 10px 16px; border-radius: 20px 20px 6px 20px; background: var(--accent-soft);
    color: var(--text); white-space: pre-wrap; overflow-wrap: anywhere; }
  .lm-a { display: flex; gap: 12px; align-items: flex-start; }
  .lm-a .lm-av { width: 30px; height: 30px; flex: none; border-radius: 50%; display: grid; place-items: center;
    background: linear-gradient(135deg, var(--accent), var(--accent-2)); color: #fff; }
  .lm-a .lm-av .lm-ic { width: 16px; height: 16px; }
  .lm-a .lm-abody { flex: 1; min-width: 0; overflow-wrap: anywhere; padding-top: 3px; }
  .lm-abody p { margin: 0 0 8px; } .lm-abody ul { margin: 0 0 8px; padding-left: 20px; }
  .lm-abody h3, .lm-abody h4 { font-size: 1rem; margin: 12px 0 4px; }
  .lm-abody.err { color: var(--error); }
  .lm-tag { display: inline-block; padding: 1px 10px; border-radius: 999px; font-size: .74rem; font-weight: 750; letter-spacing: .03em; text-transform: uppercase; }
  .lm-tag.from { background: color-mix(in srgb, var(--level) 18%, transparent); color: var(--level); }
  .lm-tag.beyond { background: var(--accent-soft); color: var(--accent); }
  .lm-think { display: inline-flex; gap: 5px; padding-top: 10px; }
  .lm-think i { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); animation: lmDot 1.1s infinite ease-in-out; }
  .lm-think i:nth-child(2) { animation-delay: .15s; } .lm-think i:nth-child(3) { animation-delay: .3s; }
  @keyframes lmDot { 0%, 80%, 100% { opacity: .25; transform: translateY(0); } 40% { opacity: 1; transform: translateY(-3px); } }

  .lm-composer { border-top: 1px solid var(--line); padding: 10px 14px calc(12px) ; background: var(--panel); }
  .lm-cbox { max-width: 760px; margin: 0 auto; border: 1px solid var(--line); border-radius: 22px; background: var(--soft); padding: 8px 8px 8px 16px;
    display: flex; flex-direction: column; gap: 4px; transition: border-color .15s, box-shadow .15s; }
  .lm-cbox:focus-within { border-color: var(--accent); box-shadow: 0 0 0 4px var(--accent-soft); }
  .lm-cbox textarea { width: 100%; resize: none; border: 0; background: transparent; color: var(--text); font: inherit; font-size: 1rem;
    line-height: 1.45; max-height: 9rem; padding: 6px 0 2px; outline: none; }
  .lm-crow { display: flex; align-items: center; gap: 8px; }
  .lm-crow select { width: auto; max-width: 62%; padding: 6px 30px 6px 12px; font-size: .84rem; border-radius: 999px; background-color: var(--panel); background-position: right 10px center; }
  .lm-crow .lm-sp { flex: 1; }
  .lm-send { width: 40px; min-height: 40px; height: 40px; padding: 0; border-radius: 50%; flex: none; }
  .lm-send .lm-ic { width: 20px; height: 20px; }
  .lm-hint { text-align: center; font-size: .74rem; color: var(--muted); margin: 6px 0 0; }

  .lm-blank { flex: 1; display: grid; place-items: center; padding: 30px; text-align: center; color: var(--muted); }
  .lm-blank .lm-big { width: 60px; height: 60px; margin: 0 auto 14px; border-radius: 50%; display: grid; place-items: center; background: var(--accent-soft); color: var(--accent); }
  .lm-blank .lm-big .lm-ic { width: 28px; height: 28px; }
  .lm-blank h3 { margin: 0 0 6px; color: var(--text); font-size: 1.15rem; }
  .lm-blank p { margin: 0 auto 14px; max-width: 34ch; }
  #cnImport { margin: 0 16px 10px; }

  /* phones: one column at a time (list, then the class) */
  @media (max-width: 899px) {
    #notesPage { --lm-h: calc(100dvh - 76px - var(--nav-h)); grid-template-columns: minmax(0, 1fr); gap: 0; }
    #notesPage[data-view=list] .lm-chatcol, #notesPage[data-view=chat] .lm-libcol { display: none; }
    .lm-head .lm-back { display: inline-flex; }
    .lm-scroll { padding: 12px; }
    .lm-sumbody { max-height: 9.5rem; }
    .lm-chips { flex-wrap: nowrap; overflow-x: auto; margin: 0 -12px; padding: 0 12px 2px; scrollbar-width: none; }
    .lm-chip { flex: none; }
    .lm-hint { display: none; }
    .lm-u { max-width: 92%; }
  }
  @media (max-width: 480px) { .lm-head .lm-cont-txt { display: none; } .lm-head .lm-cont { padding: 8px 12px; } }

  /* menus, dialogs, toast */
  .lm-menu { position: fixed; z-index: 90; min-width: 190px; padding: 6px; background: var(--panel); border: 1px solid var(--line);
    border-radius: 14px; box-shadow: 0 12px 36px rgba(0,0,0,.28); }
  .lm-menu button { width: 100%; justify-content: flex-start; min-height: 40px; padding: 8px 12px; border-radius: 10px; background: transparent; color: var(--text); font-weight: 550; }
  .lm-menu button.danger { color: var(--error); }
  @media (hover: hover) { .lm-menu button:hover { background: var(--soft); filter: none; } }
  dialog.lm-dlg { width: min(420px, calc(100vw - 32px)); padding: 22px; border: 1px solid var(--line); border-radius: 20px; background: var(--panel); color: var(--text);
    box-shadow: 0 24px 70px rgba(0,0,0,.4); }
  dialog.lm-dlg::backdrop { background: rgba(10,10,20,.5); backdrop-filter: blur(3px); }
  .lm-dlg h3 { margin: 0 0 6px; font-size: 1.15rem; } .lm-dlg p { margin: 0 0 14px; color: var(--muted); font-size: .92rem; }
  .lm-dlg .lm-acts { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; flex-wrap: wrap; }
  .lm-dlg .lm-acts .danger { background: var(--error); color: #fff; }
  .lm-radios { display: flex; flex-direction: column; gap: 2px; max-height: 40vh; overflow: auto; margin-bottom: 10px; }
  .lm-radios label { flex-direction: row; align-items: center; gap: 10px; font-size: .95rem; font-weight: 550; color: var(--text); padding: 8px 10px; border-radius: 10px; cursor: pointer; }
  .lm-radios label:hover { background: var(--soft); } .lm-radios input { width: auto; accent-color: var(--accent); }
  #lmToast { position: fixed; z-index: 95; left: 50%; bottom: calc(var(--nav-h) + 18px); transform: translate(-50%, 20px); opacity: 0; pointer-events: none;
    max-width: min(520px, calc(100vw - 28px)); padding: 12px 18px; border-radius: 14px; background: var(--text); color: var(--bg); font-size: .92rem; font-weight: 550;
    box-shadow: 0 10px 30px rgba(0,0,0,.3); transition: opacity .2s, transform .2s; }
  #lmToast.on { opacity: 1; transform: translate(-50%, 0); }
`;
document.head.append(css);

// ---------- toast / menu / dialogs ----------
const toastEl = h("div", { id: "lmToast", role: "status", "aria-live": "polite" });
document.body.append(toastEl);
let toastTimer;
function toast(text, ms = 4200) {
  toastEl.textContent = text;
  toastEl.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("on"), ms);
}
const fail = (err) => toast(A()?.friendly ? A().friendly(err) : String(err?.message ?? err), 6000);

let openMenuEl = null;
function closeMenu() { openMenuEl?.remove(); openMenuEl = null; }
document.addEventListener("click", (e) => { if (openMenuEl && !openMenuEl.contains(e.target)) closeMenu(); }, true);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });
window.addEventListener("resize", closeMenu);
function openMenu(anchor, items) {
  closeMenu();
  const menu = h("div", { class: "lm-menu", role: "menu" }, items.map((it) =>
    h("button", { type: "button", role: "menuitem", class: it.danger ? "danger" : "", onclick: () => { closeMenu(); it.run(); } }, it.label)));
  document.body.append(menu);
  const r = anchor.getBoundingClientRect(), mw = menu.offsetWidth, mh = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(r.right - mw, innerWidth - mw - 8))}px`;
  menu.style.top = `${r.bottom + 6 + mh > innerHeight ? Math.max(8, r.top - mh - 6) : r.bottom + 6}px`;
  openMenuEl = menu;
  menu.querySelector("button")?.focus();
}

// One generic modal: build(body) fills it; the promise resolves with whatever finish(value) is given (null = cancelled).
function dialog(build) {
  return new Promise((resolve) => {
    const dlg = h("dialog", { class: "lm-dlg" });
    let result = null;
    const finish = (v) => { result = v; dlg.close(); };
    build(dlg, finish);
    dlg.addEventListener("close", () => { dlg.remove(); resolve(result); });
    dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); }); // click on the dimmed backdrop = cancel
    document.body.append(dlg);
    dlg.showModal();
  });
}
const askText = ({ title, text = "", value = "", ok = "Save", placeholder = "" }) => dialog((dlg, finish) => {
  const input = h("input", { type: "text", value, placeholder, maxlength: "120", "aria-label": title });
  dlg.append(h("h3", {}, title), text && h("p", {}, text),
    h("form", { onsubmit: (e) => { e.preventDefault(); finish(input.value.trim() || null); } }, input,
      h("div", { class: "lm-acts" },
        h("button", { type: "button", class: "secondary", onclick: () => finish(null) }, "Cancel"),
        h("button", { type: "submit" }, ok))));
  setTimeout(() => { input.focus(); input.select(); }, 30);
});
const askConfirm = ({ title, text, ok = "Delete" }) => dialog((dlg, finish) => {
  dlg.append(h("h3", {}, title), h("p", {}, text),
    h("div", { class: "lm-acts" },
      h("button", { type: "button", class: "secondary", onclick: () => finish(null) }, "Cancel"),
      h("button", { type: "button", class: "danger", onclick: () => finish(true) }, ok)));
});
// Choose a folder for a class (or "no folder"), or make a new one right there.
const askFolder = (session) => dialog((dlg, finish) => {
  const folders = A().folders;
  const name = "folderChoice";
  const radio = (value, label, checked) => h("label", {}, h("input", { type: "radio", name, value, checked }), label);
  const fresh = h("input", { type: "text", placeholder: "Or make a new folder…", maxlength: "80", "aria-label": "New folder name" });
  fresh.addEventListener("input", () => { if (fresh.value) dlg.querySelectorAll("input[type=radio]").forEach((r) => { r.checked = false; }); });
  dlg.append(h("h3", {}, "Move to folder"), h("p", {}, `Where should "${session.title}" go?`),
    h("div", { class: "lm-radios" },
      radio("", "No folder", session.folderId == null),
      folders.map((f) => radio(String(f.id), f.name, session.folderId === f.id))),
    fresh,
    h("div", { class: "lm-acts" },
      h("button", { type: "button", class: "secondary", onclick: () => finish(null) }, "Cancel"),
      h("button", { type: "button", onclick: () => {
        const newName = fresh.value.trim();
        if (newName) return finish({ newName });
        const picked = dlg.querySelector("input[type=radio]:checked");
        finish({ folderId: picked && picked.value ? Number(picked.value) : null });
      } }, "Move")));
});

// ---------- state ----------
const S = {
  page: "live", sel: null, q: "", view: "list", scope: "class", expanded: false, busy: new Set(),
  open: new Set(store.get("lm_open_folders", [])),
};
const chatKey = (id) => `cn_chat_${A().userKey}_${id}`;
const loadChat = (id) => store.get(chatKey(id), []);
const saveChat = (id, msgs) => store.set(chatKey(id), msgs.slice(-60));
const byNewest = (a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0);
const sessionById = (id) => A().sessions.find((s) => s.id === id);

// ---------- navigation ----------
const PAGES = {
  notes: { label: "Class notes", sub: "Your classes, folders and questions", title: "Class notes" },
  live: { label: "Live translation", sub: "with class", title: "Live translation", subtitle: "Real-time translation for any class or meeting" },
};
const nav = h("nav", { id: "lmNav", "aria-label": "Main" },
  h("div", { class: "lm-logo" }, h("img", { src: "icons/icon-192.png", alt: "" }), h("b", {}, "Live Translate")),
  ...Object.entries(PAGES).map(([key, p]) => h("button", { type: "button", class: "lm-item", "data-page": key, onclick: () => setPage(key) },
    icon(key), h("span", {}, p.label, h("small", {}, p.sub)))),
  h("div", { class: "lm-foot" }, "Notes follow your account on every device."));
document.body.prepend(nav);

function setPage(page, { remember = true } = {}) {
  closeMenu();
  S.page = page;
  document.body.dataset.page = page;
  if (remember) store.set("lt_page", page);
  for (const b of nav.querySelectorAll(".lm-item")) {
    if (b.dataset.page === page) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  }
  const head = $("header h1"), sub = $("header .brand small");
  if (head) head.textContent = page === "notes" ? "Class notes" : "Live Translate";
  if (sub) sub.textContent = page === "notes" ? "Your classes, folders and questions" : PAGES.live.subtitle;
  document.title = page === "notes" ? "Class notes · Live Translate" : "Live Translate";
  if (page === "notes") renderAll();
  scrollTo({ top: 0 });
}
$("#settingsBtn")?.addEventListener("click", () => setPage("live", { remember: false })); // the key screen lives on the Live page

// A red dot on "Live translation" while a session runs, so you can see it from the notes page.
function markRecording() {
  const on = !!A()?.recordingId || $("#sessionBtn")?.classList.contains("live");
  nav.querySelector('[data-page="live"]').classList.toggle("rec", on);
}
const sessionBtn = $("#sessionBtn");
if (sessionBtn) new MutationObserver(markRecording).observe(sessionBtn, { attributes: true, attributeFilter: ["class"] });

// ---------- the page skeleton ----------
const page = h("section", { id: "notesPage", "data-view": "list", hidden: false },
  h("div", { class: "lm-col lm-libcol", id: "lmLib" }),
  h("div", { class: "lm-col lm-chatcol", id: "lmChat" }));
$("main").append(page);

// ---------- left: library ----------
function renderList() {
  const lib = $("#lmLib");
  const imp = document.getElementById("cnImport");
  if (imp) document.body.append(imp); // park it so replaceChildren below does not destroy the element
  lib.replaceChildren();
  const newFolder = h("button", { type: "button", class: "secondary small", onclick: () => makeFolder() }, icon("plus", "") , "Folder");
  newFolder.querySelector(".lm-ic").style.cssText = "width:14px;height:14px";
  lib.append(h("div", { class: "lm-libhead" }, h("h2", {}, "Classes"), newFolder));
  if (imp) lib.append(imp); // "Found N old classes on this device" lives from notes.js; show it here
  const search = h("input", { type: "text", placeholder: "Search classes", value: S.q, "aria-label": "Search classes",
    oninput: (e) => { S.q = e.target.value; renderListBody(); } });
  lib.append(h("div", { class: "lm-search" }, search), h("div", { class: "lm-list", id: "lmListBody" }));
  renderListBody();
}

function renderListBody() {
  const body = $("#lmListBody");
  if (!body) return;
  const api = A();
  const q = S.q.trim().toLowerCase();
  const matches = (s) => !q || s.title.toLowerCase().includes(q);
  const sessions = [...api.sessions].sort(byNewest);
  body.replaceChildren();
  if (!sessions.length) {
    body.append(h("div", { class: "lm-empty" }, "No classes yet. Open ", h("b", {}, "Live translation"), " and press Start class session. Your class will show up here."));
    return;
  }
  const folderIds = new Set(api.folders.map((f) => f.id));
  let shown = 0;
  for (const f of api.folders) {
    const inside = sessions.filter((s) => s.folderId === f.id);
    const hits = inside.filter(matches);
    if (q && !hits.length && !f.name.toLowerCase().includes(q)) continue;
    const list = q && !hits.length ? inside : hits;
    const open = q ? true : S.open.has(f.id);
    const more = h("button", { type: "button", class: "lm-more", "aria-label": `Options for folder ${f.name}`,
      onclick: (e) => { e.stopPropagation(); openMenu(more, [
        { label: "Rename folder", run: () => renameFolder(f) },
        { label: "Delete folder", danger: true, run: () => removeFolder(f) },
      ]); } }, icon("more"));
    const head = h("div", { class: "lm-ghead", role: "button", tabindex: "0", "aria-expanded": String(open),
      onclick: () => toggleFolder(f.id), onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleFolder(f.id); } } },
      icon("chev", "chev"), icon("folder", "fold"), h("span", { class: "lm-gname" }, f.name), h("span", { class: "lm-count" }, String(inside.length)), more);
    const group = h("div", { class: `lm-group${open ? " open" : ""}`, "data-folder": String(f.id) }, head, open && list.map(classRow));
    wireDrop(group, f.id);
    body.append(group);
    shown++;
  }
  const loose = sessions.filter((s) => s.folderId == null || !folderIds.has(s.folderId)).filter(matches);
  if (loose.length || (!q && api.folders.length)) {
    const wrap = h("div", { class: "lm-group open", "data-folder": "none" },
      api.folders.length ? h("div", { class: "lm-label" }, "Unfiled") : null, loose.map(classRow));
    wireDrop(wrap, null);
    body.append(wrap);
    shown += loose.length;
  }
  if (q && !shown) body.append(h("div", { class: "lm-empty" }, `Nothing matches "${S.q}".`));
}

function classRow(s) {
  const api = A();
  const rec = api.recordingId === s.id;
  const d = new Date(s.startedAt);
  const meta = `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} · ${api.fmtTime(s.startedAt)}${s.kind === "meeting" ? " · Meeting" : ""}`;
  const more = h("button", { type: "button", class: "lm-more", "aria-label": `Options for ${s.title}`,
    onclick: (e) => { e.stopPropagation(); openMenu(more, classMenu(s)); } }, icon("more"));
  const row = h("div", { class: "lm-class", role: "button", tabindex: "0", draggable: "true", "aria-current": String(S.sel === s.id),
    onclick: () => openClass(s.id), onkeydown: (e) => { if (e.key === "Enter") openClass(s.id); },
    ondragstart: (e) => { e.dataTransfer.setData("text/plain", String(s.id)); e.dataTransfer.effectAllowed = "move"; row.classList.add("dragging"); },
    ondragend: () => row.classList.remove("dragging") },
    h("div", { class: "lm-ctext" },
      h("div", { class: "lm-ctitle" }, s.title),
      h("div", { class: "lm-cmeta" }, rec ? h("span", { class: "lm-rec" }, "Recording ") : null, meta)),
    more);
  return row;
}

function wireDrop(el, folderId) {
  el.addEventListener("dragover", (e) => { e.preventDefault(); el.classList.add("drop"); });
  el.addEventListener("dragleave", (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove("drop"); });
  el.addEventListener("drop", async (e) => {
    e.preventDefault(); el.classList.remove("drop");
    const id = Number(e.dataTransfer.getData("text/plain"));
    const s = sessionById(id);
    if (!s || (s.folderId ?? null) === folderId) return;
    try { await A().moveClass(id, folderId); toast(folderId == null ? `Moved "${s.title}" out of its folder.` : `Moved "${s.title}" to ${A().folders.find((f) => f.id === folderId)?.name}.`); }
    catch (err) { fail(err); }
  });
}

function toggleFolder(id) {
  if (S.open.has(id)) S.open.delete(id); else S.open.add(id);
  store.set("lm_open_folders", [...S.open]);
  renderListBody();
}

const classMenu = (s) => [
  { label: "Continue recording", run: () => continueRecording(s.id) },
  { label: "Move to folder…", run: () => moveClass(s) },
  { label: "Rename", run: () => renameClass(s) },
  { label: "Download notes (.md)", run: () => A().exportMarkdown(s.id).catch(fail) },
  { label: "Clear chat", run: () => { saveChat(s.id, []); if (S.sel === s.id) renderChat(); toast("Chat cleared."); } },
  { label: "Delete class", danger: true, run: () => removeClass(s) },
];

// ---------- actions ----------
async function makeFolder() {
  const name = await askText({ title: "New folder", text: "For example a teacher, a subject or a course.", ok: "Create", placeholder: "Folder name" });
  if (!name) return;
  try { const id = await A().createFolder(name); if (id != null) { S.open.add(id); store.set("lm_open_folders", [...S.open]); renderListBody(); } }
  catch (err) { fail(err); }
}
async function renameFolder(f) {
  const name = await askText({ title: "Rename folder", value: f.name });
  if (name && name !== f.name) A().renameFolder(f.id, name).catch(fail);
}
async function removeFolder(f) {
  const n = A().sessions.filter((s) => s.folderId === f.id).length;
  const yes = await askConfirm({ title: `Delete folder "${f.name}"?`, ok: "Delete folder",
    text: n ? `The ${n} class${n === 1 ? "" : "es"} inside will NOT be deleted. They just move out of the folder.` : "The folder is empty." });
  if (yes) A().deleteFolder(f.id).catch(fail);
}
async function moveClass(s) {
  const res = await askFolder(s);
  if (!res) return;
  try {
    const folderId = res.newName ? await A().createFolder(res.newName) : res.folderId;
    if (res.newName) { S.open.add(folderId); store.set("lm_open_folders", [...S.open]); }
    await A().moveClass(s.id, folderId);
    if (folderId != null) { S.open.add(folderId); store.set("lm_open_folders", [...S.open]); }
    toast(folderId == null ? "Moved out of its folder." : `Moved to ${A().folders.find((f) => f.id === folderId)?.name ?? "folder"}.`);
    renderListBody();
  } catch (err) { fail(err); }
}
async function renameClass(s) {
  const title = await askText({ title: "Rename class", value: s.title });
  if (title && title !== s.title) A().rename(s.id, title).catch(fail);
}
async function removeClass(s) {
  const live = A().recordingId === s.id;
  const yes = await askConfirm({ title: `Delete "${s.title}"?`, ok: "Delete class",
    text: `${live ? "It is still recording, so recording will stop. " : ""}Its notes and saved transcript will be removed. This cannot be undone.` });
  if (!yes) return;
  try {
    await A().remove(s.id);
    localStorage.removeItem(chatKey(s.id));
    if (S.sel === s.id) { S.sel = null; S.view = "list"; }
    renderAll();
  } catch (err) { fail(err); }
}

// Continue recording = go to the Live page with this class chosen in "Start as". The session button there
// then adds new lines and new notes to the same class (the older notes and transcript stay as they are).
function continueRecording(id) {
  const s = sessionById(id);
  if (!s) return;
  const problem = A().continueClass(id);
  if (problem) { toast(problem, 6000); return; }
  const running = A().recordingId === id;
  const notesChip = $("#featNotes");
  if (!running && notesChip && !$("#sessionBtn").classList.contains("live") && notesChip.getAttribute("aria-pressed") !== "true") notesChip.click();
  setPage("live", { remember: false });
  toast(running
    ? `"${s.title}" is already recording.`
    : `Ready to continue "${s.title}". Press Start class session.`, 7000);
}

// ---------- right: one class ----------
function openClass(id) {
  S.sel = id; S.view = "chat"; S.expanded = false; S.scope = "class";
  store.set("lm_last_class", id);
  renderAll();
  const sc = $("#lmScroll"); if (sc) sc.scrollTop = sc.scrollHeight;
}

function buildHead(s) {
  const api = A();
  const rec = api.recordingId === s.id;
  const folder = api.folders.find((f) => f.id === s.folderId);
  const more = h("button", { type: "button", class: "secondary small lm-morebtn", "aria-label": "More options", onclick: () => openMenu(more, classMenu(s)) }, icon("more"));
  more.querySelector(".lm-ic").style.cssText = "width:18px;height:18px";
  const cont = h("button", { type: "button", class: "small lm-cont", onclick: () => continueRecording(s.id) },
    icon("live"), h("span", { class: "lm-cont-txt" }, rec ? "Open live view" : "Continue recording"));
  cont.querySelector(".lm-ic").style.cssText = "width:16px;height:16px";
  return h("div", { class: "lm-head", id: "lmHead" },
    h("button", { type: "button", class: "lm-back", "aria-label": "Back to classes", onclick: () => { S.view = "list"; page.dataset.view = "list"; } }, icon("back")),
    h("div", { class: "lm-htext" },
      h("h2", {}, s.title),
      h("small", {}, `${new Date(s.startedAt).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })} · ${api.fmtTime(s.startedAt)}`,
        s.kind === "meeting" ? " · Meeting" : "", folder ? ` · ${folder.name}` : "", rec ? " · " : "", rec ? h("span", { class: "lm-rec" }, "Recording") : null)),
    cont, more);
}

function renderChat() {
  const col = $("#lmChat");
  const api = A();
  const s = S.sel != null ? sessionById(S.sel) : null;
  col.replaceChildren();
  page.dataset.view = s ? S.view : "list";
  if (!s) {
    col.append(h("div", { class: "lm-blank" }, h("div", {},
      h("div", { class: "lm-big" }, icon("spark")),
      h("h3", {}, api.sessions.length ? "Pick a class" : "Your notes will appear here"),
      h("p", {}, api.sessions.length
        ? "Open a class on the left to read its notes and ask questions about it."
        : "Record a class on the Live translation page, then come back here to ask questions about it."),
      !api.sessions.length && h("button", { type: "button", onclick: () => setPage("live") }, "Go to Live translation"))));
    return;
  }
  col.append(buildHead(s));

  const summary = h("div", { class: `lm-summary${S.expanded ? " open" : ""}`, id: "lmSummary" });
  const msgs = h("div", { class: "lm-msgs", id: "lmMsgs" });
  const chips = h("div", { class: "lm-chips", id: "lmChips" }, ...QUICK.map((c) =>
    h("button", { type: "button", class: "lm-chip", onclick: () => send(c.label, c), title: c.hint }, icon("spark"), c.label)));
  col.append(h("div", { class: "lm-scroll", id: "lmScroll" }, h("div", { class: "lm-inner" }, summary, chips, msgs)));

  const ta = h("textarea", { rows: "1", placeholder: "Ask about this class, or anything related…", "aria-label": "Ask a question", id: "lmAsk" });
  const sendBtn = h("button", { type: "submit", class: "lm-send", "aria-label": "Send" }, icon("send"));
  const scope = h("select", { "aria-label": "What to search", id: "lmScope", onchange: (e) => { S.scope = e.target.value; } });
  fillScope(scope, s);
  const form = h("form", { class: "lm-cbox", onsubmit: (e) => { e.preventDefault(); const t = ta.value.trim(); if (t) { ta.value = ""; grow(); send(t); } } },
    ta, h("div", { class: "lm-crow" }, scope, h("span", { class: "lm-sp" }), sendBtn));
  const grow = () => { ta.style.height = "auto"; ta.style.height = `${Math.min(ta.scrollHeight, 144)}px`; };
  ta.addEventListener("input", grow);
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } });
  col.append(h("div", { class: "lm-composer" }, form, h("p", { class: "lm-hint" }, "Answers use your class notes first, then general knowledge. They are labelled so you can tell which is which.")));

  renderSummary(s);
  renderMsgs();
}

function fillScope(select, s) {
  const api = A();
  select.replaceChildren(new Option("Searching: this class", "class"));
  const inFolder = s.folderId != null ? api.sessions.filter((x) => x.folderId === s.folderId) : [];
  if (inFolder.length > 1) select.append(new Option(`Searching: folder "${api.folders.find((f) => f.id === s.folderId)?.name}" (${inFolder.length} classes)`, "folder"));
  if (api.sessions.length > 1) select.append(new Option(`Searching: all my classes (${api.sessions.length})`, "all"));
  if (![...select.options].some((o) => o.value === S.scope)) S.scope = "class";
  select.value = S.scope;
}

let sumToken = 0;
async function renderSummary(s) {
  const box = $("#lmSummary");
  if (!box) return;
  const token = ++sumToken;
  let notes = [];
  try { notes = await A().notesFor(s.id); } catch (err) { /* shown below */ }
  if (token !== sumToken || S.sel !== s.id) return;
  const md = notes.map((n) => n.markdown).join("\n\n");
  const body = h("div", { class: "lm-sumbody", html: md ? A().renderMarkdown(md) : "" });
  if (!md) body.append(h("p", { class: "lm-none" }, A().recordingId === s.id
    ? "Notes appear here a couple of minutes after the teacher starts talking."
    : "No notes yet for this class. Continue recording, or press Update notes if lines were saved."));
  const upd = h("button", { type: "button", class: "secondary small", onclick: async (e) => {
    const btn = e.currentTarget; btn.disabled = true; btn.textContent = "Updating…";
    const res = await A().updateNotes(s.id).catch((err) => ({ ok: false, message: A().friendly(err) }));
    btn.disabled = false; btn.textContent = "Update notes";
    if (res.message) toast(res.message, 6000);
    renderSummary(s);
  } }, "Update notes");
  box.replaceChildren(h("div", { class: "lm-sumhead" }, h("b", {}, "Class notes"), upd), body);
  // Long notes are clipped with a fade; one button opens the rest.
  requestAnimationFrame(() => {
    if (token !== sumToken) return;
    const long = body.scrollHeight > body.clientHeight + 8 || S.expanded;
    body.classList.toggle("clip", long && !S.expanded);
    if (long) box.append(h("div", { class: "lm-sumfoot" }, h("button", { type: "button", class: "secondary small",
      onclick: () => { S.expanded = !S.expanded; box.classList.toggle("open", S.expanded); body.classList.toggle("clip", false); renderSummary(s); } },
      S.expanded ? "Show less" : "Show full notes")));
  });
}

function msgNode(m) {
  if (m.role === "user") return h("div", { class: "lm-u" }, m.text);
  const body = h("div", { class: `lm-abody${m.error ? " err" : ""}`, html: m.error ? "" : A().renderMarkdown(m.text) });
  if (m.error) body.textContent = m.text;
  for (const b of body.querySelectorAll("b")) { // turn the two answer labels into small coloured tags
    const t = b.textContent.trim().toLowerCase();
    if (t === "from class") { b.className = "lm-tag from"; b.textContent = "From class"; }
    else if (t === "beyond the class") { b.className = "lm-tag beyond"; b.textContent = "Beyond the class"; }
  }
  return h("div", { class: "lm-a" }, h("div", { class: "lm-av" }, icon("spark")), body);
}

function renderMsgs() {
  const box = $("#lmMsgs");
  if (!box || S.sel == null) return;
  const msgs = loadChat(S.sel);
  box.replaceChildren(...msgs.map(msgNode));
  if (S.busy.has(S.sel)) box.append(h("div", { class: "lm-a" }, h("div", { class: "lm-av" }, icon("spark")), h("div", { class: "lm-think", "aria-label": "Thinking" }, h("i"), h("i"), h("i"))));
  const sc = $("#lmScroll"); if (sc) requestAnimationFrame(() => { sc.scrollTop = sc.scrollHeight; });
}

// Quick actions. "prompt" is what Gemini is asked; "label" is what shows in the chat.
const QUICK = [
  { label: "Summarize", hint: "A short summary", prompt: "Summarize this class in a short, clear list of the main ideas. Keep it brief." },
  { label: "Key points", hint: "What to remember", prompt: "List the key points, definitions and any formulas or dates I should remember from this class." },
  { label: "Quiz me", hint: "Practice questions", prompt: "Quiz me on this class. Ask ONE question now and wait for my answer. After I answer, tell me if I was right, explain briefly, then ask the next question. In the 'Beyond the class' part just leave a short hint, not the answer." },
  { label: "What did I miss", hint: "The last 15 minutes", special: "catchup" },
];

async function send(text, quick = null) {
  const id = S.sel;
  const s = sessionById(id);
  if (!s || S.busy.has(id)) return;
  const api = A();
  const msgs = loadChat(id);
  const history = msgs.filter((m) => !m.error).slice(-6)
    .map((m) => `${m.role === "user" ? "Student" : "Assistant"}: ${m.text.slice(0, 700)}`).join("\n");
  msgs.push({ role: "user", text });
  saveChat(id, msgs);
  S.busy.add(id);
  renderMsgs();
  let reply;
  try {
    if (quick?.special === "catchup") {
      reply = { role: "assistant", text: `**From class** (the last 15 minutes)\n${await api.catchUp(id, 15)}` };
    } else {
      const ids = S.scope === "all" ? api.sessions.map((x) => x.id)
        : S.scope === "folder" && s.folderId != null ? api.sessions.filter((x) => x.folderId === s.folderId).map((x) => x.id) : [id];
      const question = (history ? `Earlier in this chat:\n${history}\n\nNow answer this follow-up. ` : "") + (quick?.prompt ?? text);
      reply = { role: "assistant", text: await api.ask(ids, question) };
    }
  } catch (err) {
    reply = { role: "assistant", error: true, text: api.friendly(err) };
  }
  const after = loadChat(id);
  after.push(reply);
  saveChat(id, after);
  S.busy.delete(id);
  if (S.sel === id) renderMsgs();
}

// ---------- put it together ----------
function renderAll() {
  const api = A();
  if (!api) return;
  if (S.sel != null && !sessionById(S.sel)) { S.sel = null; S.view = "list"; }
  if (S.sel == null && api.sessions.length && matchMedia("(min-width: 900px)").matches) {
    const last = store.get("lm_last_class");
    S.sel = api.recordingId ?? (sessionById(last) ? last : [...api.sessions].sort(byNewest)[0].id);
  }
  renderList();
  renderChat();
  markRecording();
}

// notes.js says something changed (a class started/ended, notes written, folder edited). Redraw cheaply.
let changeTimer;
document.addEventListener("cn-change", () => {
  clearTimeout(changeTimer);
  changeTimer = setTimeout(() => {
    markRecording();
    if (S.page !== "notes") return;
    renderList();
    const s = S.sel != null ? sessionById(S.sel) : null;
    if (!s || !$("#lmHead")) { renderAll(); return; }
    // Keep the chat box and what you are typing as they are; only refresh the header, summary and scope list.
    $("#lmHead").replaceWith(buildHead(s));
    const scope = $("#lmScope"); if (scope) fillScope(scope, s);
    renderSummary(s);
  }, 60);
});

// ---------- start ----------
function init() {
  if (!A()) { // notes.js did not load (for example the Gemini library was blocked): say so instead of a blank page
    page.append(h("div", { class: "lm-blank", style: "grid-column:1/-1" }, h("div", {},
      h("h3", {}, "Class notes could not load"), h("p", {}, "Check your internet connection and reload the page."),
      h("button", { type: "button", onclick: () => location.reload() }, "Reload"))));
  }
  const start = store.get("lt_page") === "notes" ? "notes" : "live";
  setPage(start, { remember: false });
}
init();
