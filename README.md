# Live Translate

Speak into your browser and see a running translation. The browser's built-in speech
recognition turns your speech into text as you talk; each finished sentence is sent to
Google Gemini (`gemini-3.5-flash-lite`, free tier) and the translation streams back next to it.

## Run it

Get a free Gemini API key at https://aistudio.google.com/apikey (sign in with your
Google account, no card needed), then in your own terminal:

```bash
export GEMINI_API_KEY=your-key
uv run uvicorn server:app --port 8010
```

Set `GEMINI_MODEL` to try a different model, e.g. `gemini-3.8-flash`.

Open http://localhost:8010 in **Chrome, Edge or Safari** (Firefox has no speech
recognition; you can still type into the box at the bottom). Pick the language you're
speaking and the one to translate into, then press **Start listening**.

**Auto-detect (Hindi, English or a mix)** is the default. It's made for classes where
people switch between Hindi and English, even mid-sentence. The model works out which
language(s) were spoken, tags each line (e.g. "Hindi + English"), and translates it all
into the target language (English by default).

## How it works

- `static/index.html` uses the Web Speech API (`SpeechRecognition`). Words in progress
  are shown in italics; when the browser marks a sentence final, it's sent to the server.
- `server.py` (FastAPI) calls Gemini and streams the text back. The last few sentences
  go along as context so names and pronouns stay consistent.
- Free tier: Google may use what you send to improve its products, and there are
  per-minute and per-day request limits.

Note: in Chrome, the speech recognition itself runs on Google's servers.
