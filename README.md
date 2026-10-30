# Live Translate

Live classroom translation that works on phones and laptops. Put your device near whoever
is talking and see their words translated as they speak, in Hindi, Telugu, Tamil, English
or any of 70+ languages, even when people mix languages in one sentence.

**Open the app: https://kasimshaik2508.github.io/live-translate/**

It's free: each person uses their own free Google Gemini key, saved only on their device.

---

## Get started (2 minutes, once)

1. Open **https://kasimshaik2508.github.io/live-translate/** in Chrome (Android, Windows,
   Mac) or Safari (iPhone).
2. Get your own free Gemini key: go to https://aistudio.google.com/apikey, sign in with your
   Google account, click **Create API key**, and copy it.
3. Paste the key into the app and tap **Save key**.

### Install it like an app (optional)

- **Android / Chrome:** tap **Install Live Translate** on the page, or the browser menu →
  **Install app** / **Add to Home screen**.
- **iPhone:** in Safari, tap the **Share** button → **Add to Home Screen**.
- **Laptop (Chrome / Edge):** click the install icon at the right of the address bar.

## Use it

1. Choose a **Mode** and the language to **Translate to** (English by default).
2. Tap **Start listening** and allow the microphone.
3. Keep the screen on; phones stop the microphone when the screen locks.

### Which mode?

| Mode | Best for |
|---|---|
| **Continuous** | Fastest. Words are translated while people talk. Best when the class mostly uses one language (mixing in English is fine, e.g. Hinglish). |
| **Sentence by sentence** | Most accurate. Each line appears about a second after the speaker pauses, tagged with the language. Best when different speakers switch between several languages. |

### Tips

- Keep the device close to the speaker. The green bar shows the microphone level; if it
  barely moves when someone talks, move closer.
- You can also type something into the box at the bottom to translate it.
- **Settings** lets you change or remove your key.

### Problems?

| What you see | What to do |
|---|---|
| "key isn't valid" | Copy the key again from AI Studio and paste the whole thing (Settings → paste new key). |
| "Free-tier limit reached" | Wait a minute. Free keys have per-minute and per-day limits. |
| "Microphone access was blocked" | Tap the icon left of the address bar, allow the microphone, and reload. On a Mac also check System Settings → Privacy & Security → Microphone. |
| It stopped listening | The screen probably locked. Tap **Start listening** again. |
| Wrong language in Continuous mode | Switch to **Sentence by sentence**. |

### Privacy

Your key is stored only in your browser on your device and is sent only to Google. What
the app hears is sent to Google to be transcribed and translated; on the free tier, Google
may use it to improve its products. Some schools don't allow recording lectures; check
with your teacher first.

---

## How it works

It's a static web app (no server of ours) hosted on GitHub Pages. The browser records the
microphone as 16 kHz audio (`audio-worklet.js`) and streams it straight to Google using the
Gemini JavaScript SDK (`gemini.js`) with the user's own key:

- **Continuous:** Gemini's live interpreter (`gemini-3.5-live-translate-preview`) translates
  while people speak.
- **Sentence by sentence:** Gemini Live (`gemini-3.5-transcribe-live`) writes down each
  sentence, detecting the language(s), then `gemini-3.5-flash-lite` translates it with the
  last few sentences as context.

Live sessions last at most 10 minutes, so the app switches to a fresh one every 9 minutes;
audio during the switch is buffered, not lost. `sw.js` and `manifest.webmanifest` make it
installable.

To run it locally, serve the folder with any static server, e.g.
`python3 -m http.server 8012`, and open http://localhost:8012.
