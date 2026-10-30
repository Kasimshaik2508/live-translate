# Live Translate

Live classroom translation in your browser. Put your laptop near whoever is talking and
see their words translated into English as they speak. Made for classes where people
switch between Hindi and English, even in the middle of a sentence.

It's free to use: it runs on your own laptop with your own free Google Gemini key.

---

## Set it up (about 10 minutes, once)

### 1. Download this project

On this page, click the green **Code** button → **Download ZIP**, then unzip it.
You'll get a folder called `live-translate-main`. Put it somewhere easy, like your
Desktop or Documents.

### 2. Get your own free Gemini key

1. Go to https://aistudio.google.com/apikey and sign in with your Google account.
2. Click **Create API key** and copy it.

Keep this key to yourself, like a password. Don't share it or post it anywhere.

### 3. Put the key in a `.env` file

Inside the `live-translate-main` folder, create a file named exactly `.env`
(a dot, then "env", with no other extension) containing this one line, using your key:

```
GEMINI_API_KEY=paste-your-key-here
```

- **Mac:** open TextEdit, choose **Format → Make Plain Text**, type the line, then save
  it into the folder as `.env`. If macOS warns about names starting with a dot, choose
  **Use "."**.
- **Windows:** open Notepad, type the line, choose **File → Save As**, set
  **Save as type** to **All files**, and save it into the folder as `.env`.

### 4. Install uv (the tool that runs the app)

- **Mac:** open the **Terminal** app and paste:
  ```bash
  curl -LsSf https://astral.sh/uv/install.sh | sh
  ```
- **Windows:** open **PowerShell** and paste:
  ```powershell
  powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
  ```

Close and reopen Terminal / PowerShell afterwards.

---

## Use it (every time)

1. Open Terminal (Mac) or PowerShell (Windows) and go into the folder. The easiest way
   is to type `cd ` (with a space) and then drag the folder onto the window, then press
   Enter.
2. Start the app:
   ```bash
   uv run uvicorn server:app --port 8010
   ```
   The first time takes a minute while it downloads what it needs. Leave this window open.
3. Open http://localhost:8010 in **Google Chrome** (Edge or Safari also work).
4. Click **Start listening** and allow the microphone when asked.
5. When you're done, click **Stop**, then press **Ctrl+C** in the Terminal window.

### Modes

- **Continuous (fastest)**, the default: English appears while people are still talking.
  It occasionally mishears a word in mixed Hindi-English.
- **Sentence by sentence (most accurate)**: each line appears about a second after the
  speaker pauses, with a tag showing the language (Hindi, English or Hindi + English).

### Tips

- Keep the laptop close to the speaker. The green bar shows the microphone level; if it
  barely moves when someone talks, move closer.
- You can also type something into the box at the bottom to translate it.
- **Clear** wipes the screen.

### Problems?

| What you see | What to do |
|---|---|
| "no Gemini API key" | The `.env` file is missing, misnamed (e.g. `.env.txt`) or not in the folder. Restart the app after fixing it. |
| "invalid Gemini API key" | Copy the key again from AI Studio into `.env`, then restart the app. |
| "free-tier limit reached" | Wait a minute. Free keys have per-minute and per-day limits. |
| "address already in use" | The app is already running in another window. Use that one, or press Ctrl+C there first. |
| "Microphone access was blocked" | Click the icon left of the address bar, allow the microphone, and reload. On Mac also check System Settings → Privacy & Security → Microphone → Google Chrome. |
| Continuous mode acts up | Switch to **Sentence by sentence**. Continuous mode uses a Google "preview" model that may change. |

### Privacy

What the app hears is sent to Google to be transcribed and translated. On the free tier,
Google may use it to improve its products. Some schools don't allow recording lectures;
check with your teacher first.

---

## How it works (for the curious)

The page records the microphone as 16 kHz audio and streams it to a small Python server
(`server.py`) over a WebSocket. The server streams it to Gemini and sends text back as it
arrives:

- **Continuous:** Gemini's live interpreter (`gemini-3.5-live-translate-preview`)
  translates while people speak.
- **Sentence by sentence:** Gemini Live (`gemini-3.5-transcribe-live`) writes down each
  sentence, detecting Hindi, English or a mix, then `gemini-3.5-flash-lite` translates it
  with the last few sentences as context.

Live sessions last at most 10 minutes, so the server reconnects every 9 minutes; audio
during the switch is buffered, not lost.

Optional settings in `.env`: `GEMINI_MODEL` (translation), `GEMINI_LIVE_MODEL`
(transcription), `GEMINI_INTERPRETER_MODEL` (continuous mode).
