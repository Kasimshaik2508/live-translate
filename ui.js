// Presentation helpers for index.html: the Fast/Accurate mode switch and the glow around the mic
// button. The real controls (select#mode, #meter) stay where app.js expects them; this file only
// mirrors them, so app.js does not need to know about the new look.
const mode = document.getElementById("mode");
const seg = document.getElementById("modeSeg");
const toggle = document.getElementById("toggle");

// Mode switch: one button per <option>; clicking one changes the hidden select like a user would.
const buttons = [...mode.options].map((opt) => {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.dataset.value = opt.value;
  btn.innerHTML = `<b></b><small></small>`;
  btn.querySelector("b").textContent = opt.dataset.short || opt.textContent;
  btn.querySelector("small").textContent = opt.dataset.sub || "";
  btn.onclick = () => {
    if (mode.value === opt.value) return;
    mode.value = opt.value;
    mode.dispatchEvent(new Event("change"));
  };
  seg.append(btn);
  return btn;
});
const sync = () => buttons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.value === mode.value)));

// app.js sometimes sets mode.value itself (e.g. picking a spoken language switches to Sentence mode),
// which fires no event, so watch the property directly.
const native = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
Object.defineProperty(mode, "value", {
  get() { return native.get.call(this); },
  set(v) { native.set.call(this, v); sync(); },
});
sync();

// Mic glow: app.js sets the meter bar's width to the input level; turn that into a CSS variable.
const bar = document.querySelector("#meter > div");
new MutationObserver(() => {
  toggle.style.setProperty("--lvl", String(Math.min(1, (parseFloat(bar.style.width) || 0) / 100)));
}).observe(bar, { attributes: true, attributeFilter: ["style"] });
