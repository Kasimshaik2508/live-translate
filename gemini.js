// Everything that talks to Gemini. Runs in the browser (and in Node for tests);
// the caller passes in a GoogleGenAI client made with the user's own API key.

export const MODELS = {
  // Fast free-tier model Google describes as optimized for translation.
  translate: "gemini-3.5-flash-lite",
  // Streaming speech-to-text that detects the language(s), including code-switching.
  transcribe: "gemini-3.5-transcribe-live",
  // Live interpreter: translates continuously while people are still speaking.
  interpreter: "gemini-3.5-live-translate-preview",
};

// Live sessions are capped at 10 minutes, so switch to a fresh one a little before that.
const SESSION_MS = 9 * 60 * 1000;
const MAX_BUFFERED_CHUNKS = 300; // ~30 s of audio kept while (re)connecting

export const SYSTEM = `You are a live interpreter in a classroom. You receive one utterance at a time, \
transcribed from speech, and return its translation into the target language.

Detect the language yourself from the text. Speakers often mix languages inside one \
sentence, for example Hindi and English (Hinglish) or Telugu and English. A language may \
arrive in its own script or in Latin letters, and English words are sometimes transcribed \
in another script (for example "मीटिंग" for "meeting").

Reply in exactly this format, with nothing before or after:
<lang>LANGUAGES</lang>TRANSLATION

- LANGUAGES: the language(s) actually spoken, in English, joined with " + " when mixed, \
e.g. "Hindi", "English", "Hindi + English", "Tamil".
- TRANSLATION: the whole utterance in natural target-language text, mixed parts included. \
No quotes, notes, or explanations.
- If the utterance is entirely in the target language already, repeat it as-is, fixing \
only obvious transcription errors.
- Speech recognition makes mistakes. When a word is clearly misheard, translate what the \
speaker most likely said.
- Keep the speaker's tone and register. Keep names, numbers, technical terms and units.
- Earlier utterances are given for context only; translate just the new one.`;

export function buildPrompt(text, targetLang, history = []) {
  const lines = [];
  if (history.length) {
    lines.push("<context>");
    for (const turn of history) lines.push(`Speaker: ${turn.source}\nTranslation: ${turn.translation}`);
    lines.push("</context>\n");
  }
  lines.push(`Target language: ${targetLang}`);
  lines.push(`<utterance>${text}</utterance>`);
  return lines.join("\n");
}

// The model replies "<lang>Hindi + English</lang>translation"; split that as it streams in.
export function parseReply(raw) {
  const open = "<lang>", close = "</lang>";
  if (raw.startsWith(open)) {
    const end = raw.indexOf(close);
    if (end === -1) return { lang: "", text: "" }; // tag still arriving
    return { lang: raw.slice(open.length, end).trim(), text: raw.slice(end + close.length).trimStart() };
  }
  if (open.startsWith(raw)) return { lang: "", text: "" }; // first few characters of the tag
  return { lang: "", text: raw }; // the model skipped the tag
}

// Turn an SDK error or a WebSocket close reason into a short message for people.
export function describeError(err) {
  const text = String(err?.message ?? err?.reason ?? err ?? "");
  const status = err?.status ?? err?.code;
  if (/api key not valid|api_key_invalid|invalid api key/i.test(text) || status === 401) {
    return "Your Gemini API key isn't valid. Check it in Settings.";
  }
  if (status === 429 || /quota|rate limit|resource.?exhausted|exceeded/i.test(text)) {
    return "Free-tier limit reached. Wait a minute and try again.";
  }
  if (status === 403 || /permission/i.test(text)) {
    return "This API key isn't allowed to use Gemini. Create a new key in AI Studio.";
  }
  if (/failed to fetch|network|offline/i.test(text)) {
    return "Can't reach Google. Check your internet connection.";
  }
  return text ? `Gemini error: ${text}` : "Something went wrong talking to Gemini.";
}

// Cheap call to confirm a key works before saving it.
export async function checkKey(ai) {
  await ai.models.get({ model: MODELS.translate });
}

export async function* streamTranslation(ai, text, targetLang, history = []) {
  const stream = await ai.models.generateContentStream({
    model: MODELS.translate,
    contents: buildPrompt(text, targetLang, history),
    config: { systemInstruction: SYSTEM },
  });
  for await (const chunk of stream) {
    if (chunk.text) yield chunk.text;
  }
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/**
 * Streams 16 kHz 16-bit mono PCM to Gemini Live and reports text through `on`:
 *   continuous mode: heard(text), translated(text)       fragments to append
 *   sentence mode:   interim(text), final(id, text), translation(id, rawReply)
 *   both:            listening(), error(message)        error means listening stopped
 */
export class LiveTranslator {
  constructor(ai, { mode, targetLang, targetCode, on }) {
    this.ai = ai;
    this.continuous = mode === "continuous";
    this.targetLang = targetLang;
    this.targetCode = targetCode;
    this.on = on;
    this.session = null;
    this.pending = [];
    this.history = [];
    this.nextId = 1;
    this.stopped = false;
    this.failures = 0;
    this.renewTimer = null;
  }

  async start() {
    await this.connect();
  }

  sendAudio(buffer) {
    if (this.stopped) return;
    if (!this.session) {
      if (this.pending.length >= MAX_BUFFERED_CHUNKS) this.pending.shift();
      this.pending.push(buffer);
      return;
    }
    this.session.sendRealtimeInput({ audio: { data: toBase64(buffer), mimeType: "audio/pcm;rate=16000" } });
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.renewTimer);
    const session = this.session;
    this.session = null;
    session?.close();
  }

  config() {
    if (this.continuous) {
      return {
        responseModalities: ["AUDIO"], // the interpreter only speaks; we use the transcripts
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        translationConfig: { targetLanguageCode: this.targetCode, echoTargetLanguage: true },
      };
    }
    return {
      responseModalities: ["TEXT"],
      inputAudioTranscription: { languageCodes: [] }, // empty = detect automatically
      realtimeInputConfig: {
        // End a sentence after half a second of silence so translations start sooner.
        automaticActivityDetection: { silenceDurationMs: 500 },
      },
    };
  }

  async connect() {
    let session = null;
    let opened = false;
    // Google may close the socket before connect() settles (e.g. a bad key); surface that.
    let rejectEarly;
    const closedEarly = new Promise((_, reject) => (rejectEarly = reject));
    const opening = this.ai.live.connect({
      model: this.continuous ? MODELS.interpreter : MODELS.transcribe,
      config: this.config(),
      callbacks: {
        onmessage: (message) => this.handle(message, session),
        onerror: () => {}, // details arrive in onclose
        onclose: (event) => {
          if (opened) this.closed(event, session);
          else rejectEarly({ reason: event?.reason || "connection closed", code: event?.code });
        },
      },
    });
    session = await Promise.race([opening, closedEarly]);
    opened = true;
    if (this.stopped) { session.close(); return; }
    const previous = this.session;
    this.session = session;
    previous?.close();
    this.failures = 0;
    for (const chunk of this.pending.splice(0)) this.sendAudio(chunk);
    clearTimeout(this.renewTimer);
    this.renewTimer = setTimeout(() => this.renew(), SESSION_MS);
    this.on.listening?.();
  }

  // Open a fresh session before the old one hits its time limit; audio is buffered meanwhile.
  async renew() {
    if (this.stopped) return;
    const old = this.session;
    this.session = null;
    try {
      await this.connect();
    } catch (err) {
      this.fail(err);
    }
    old?.close();
  }

  closed(event, session) {
    if (this.stopped || session !== this.session) return; // we closed it on purpose
    this.session = null;
    const reason = event?.reason || "";
    if (event?.code === 1000 && !reason) { this.renew(); return; }
    const message = describeError({ reason, code: event?.code });
    if (/isn't valid|isn't allowed|limit reached/.test(message) || ++this.failures >= 3) {
      this.fail({ reason });
      return;
    }
    setTimeout(() => this.renew(), 1000);
  }

  fail(err) {
    this.stop();
    this.on.error?.(describeError(err));
  }

  handle(message, session) {
    if (session !== this.session) return;
    if (message.goAway) { this.renew(); return; }
    const content = message.serverContent;
    if (!content) return;
    if (this.continuous) {
      if (content.inputTranscription?.text) this.on.heard?.(content.inputTranscription.text);
      if (content.outputTranscription?.text) this.on.translated?.(content.outputTranscription.text);
      return; // the translated audio in modelTurn is not used
    }
    if (content.interimInputTranscription?.text) this.on.interim?.(content.interimInputTranscription.text);
    const text = content.inputTranscription?.text?.trim();
    if (text) {
      const id = this.nextId++;
      this.on.final?.(id, text);
      this.translateSentence(id, text);
    }
  }

  async translateSentence(id, text) {
    let raw = "";
    try {
      for await (const piece of streamTranslation(this.ai, text, this.targetLang, this.history.slice(-6))) {
        raw += piece;
        this.on.translation?.(id, raw);
      }
      this.history.push({ source: text, translation: parseReply(raw).text });
    } catch (err) {
      this.on.translation?.(id, `[${describeError(err)}]`);
    }
  }
}
