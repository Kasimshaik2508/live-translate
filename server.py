"""Live translation server.

The browser streams microphone audio over a WebSocket. Gemini Live transcribes it
(detecting Hindi, English or a mix by itself), and each finished sentence is translated
by a fast Gemini model and streamed back to the page.
"""

import asyncio
import itertools
import logging
import os
from collections.abc import AsyncIterator
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, StreamingResponse
from google import genai
from google.genai import errors, types
from pydantic import BaseModel, Field


def load_env_file(path: Path) -> None:
    """Read KEY=value lines from .env without overriding variables already set."""
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        key, sep, value = line.strip().partition("=")
        if sep and key and not key.startswith("#"):
            os.environ.setdefault(key.strip(), value.strip().strip("\"'"))


load_env_file(Path(__file__).parent / ".env")
# Free-tier model Google describes as optimized for translation; override with GEMINI_MODEL.
MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.5-flash-lite")
# Streaming speech-to-text that auto-detects languages, including code-switching.
LIVE_MODEL = os.environ.get("GEMINI_LIVE_MODEL", "gemini-3.5-transcribe-live")
# Live interpreter: translates continuously while people are still speaking.
INTERPRETER_MODEL = os.environ.get("GEMINI_INTERPRETER_MODEL", "gemini-3.5-live-translate-preview")
# Live transcription sessions are capped at 10 minutes, so reconnect a little before that.
SESSION_SECONDS = 9 * 60
STATIC = Path(__file__).parent / "static"

SYSTEM = """You are a live interpreter in a classroom. You receive one utterance at a time, \
transcribed from speech, and return its translation into the target language.

First detect the language yourself; never trust the "spoken language" hint over the text. \
Speakers often mix languages inside one sentence, most commonly Hindi and English \
(Hinglish). Hindi may arrive in Devanagari or in Latin letters, and English words are \
sometimes transcribed in Devanagari (for example "मीटिंग" for "meeting").

Reply in exactly this format, with nothing before or after:
<lang>LANGUAGES</lang>TRANSLATION

- LANGUAGES: the language(s) actually spoken, in English, joined with " + " when mixed, \
e.g. "Hindi", "English", "Hindi + English".
- TRANSLATION: the whole utterance in natural target-language text, mixed parts included. \
No quotes, notes, or explanations.
- If the utterance is entirely in the target language already, repeat it as-is, fixing \
only obvious transcription errors (and writing English in Latin letters).
- Speech recognition makes mistakes. When a word is clearly misheard, translate what the \
speaker most likely said.
- Keep the speaker's tone and register. Keep names, numbers, technical terms and units.
- Earlier utterances are given for context only; translate just the new one."""

log = logging.getLogger("uvicorn.error")
app = FastAPI()
_client: genai.Client | None = None


def get_client() -> genai.Client:
    # Created on first use so the page still loads (and can show the error) without a key.
    global _client
    if _client is None:
        if not (os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")):
            raise ValueError("No API key was provided")
        _client = genai.Client()  # reads GEMINI_API_KEY or GOOGLE_API_KEY
    return _client


class Turn(BaseModel):
    source: str
    translation: str


class TranslateRequest(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
    source_lang: str
    target_lang: str
    history: list[Turn] = Field(default_factory=list, max_length=10)


def build_prompt(req: TranslateRequest) -> str:
    lines = []
    if req.history:
        lines.append("<context>")
        for turn in req.history:
            lines.append(f"Speaker: {turn.source}\nTranslation: {turn.translation}")
        lines.append("</context>\n")
    lines.append(f"Spoken language hint: {req.source_lang}")
    lines.append(f"Target language: {req.target_lang}")
    lines.append(f"<utterance>{req.text}</utterance>")
    return "\n".join(lines)


def describe_error(e: errors.APIError) -> str:
    if e.code == 429:
        return "[error: free-tier limit reached, wait a minute and try again]"
    if e.code in (400, 401, 403) and "key" in str(e).lower():
        return "[error: invalid Gemini API key]"
    return f"[error: Gemini API returned {e.code}]"


async def stream_translation(req: TranslateRequest) -> AsyncIterator[str]:
    """Yield the raw reply ("<lang>…</lang>translation") as it streams, or one error line."""
    try:
        stream = await get_client().aio.models.generate_content_stream(
            model=MODEL,
            contents=build_prompt(req),
            config=types.GenerateContentConfig(system_instruction=SYSTEM),
        )
        async for chunk in stream:
            if chunk.text:
                yield chunk.text
    except ValueError as e:
        if "API key" not in str(e):
            raise
        yield "[error: no Gemini API key; set GEMINI_API_KEY and restart]"
    except errors.APIError as e:
        yield describe_error(e)


@app.get("/")
async def index():
    return FileResponse(STATIC / "index.html")


@app.post("/api/translate")
async def translate(req: TranslateRequest):
    return StreamingResponse(stream_translation(req), media_type="text/plain; charset=utf-8")


def interpreter_config(target_code: str) -> types.LiveConnectConfig:
    return types.LiveConnectConfig(
        response_modalities=["AUDIO"],  # the model only speaks; we use the text transcripts
        input_audio_transcription=types.AudioTranscriptionConfig(),
        output_audio_transcription=types.AudioTranscriptionConfig(),
        translation_config=types.TranslationConfig(
            target_language_code=target_code,
            echo_target_language=True,  # pass speech already in the target language through
        ),
    )


def live_config() -> types.LiveConnectConfig:
    return types.LiveConnectConfig(
        response_modalities=["TEXT"],
        input_audio_transcription=types.AudioTranscriptionConfig(language_codes=[]),  # auto-detect
        realtime_input_config=types.RealtimeInputConfig(
            # End a sentence after half a second of silence so translations start sooner.
            automatic_activity_detection=types.AutomaticActivityDetection(silence_duration_ms=500),
        ),
    )


@app.websocket("/ws")
async def listen(
    ws: WebSocket, target: str = "English", target_code: str = "en", mode: str = "continuous"
):
    """Receive 16 kHz 16-bit mono PCM chunks; send back JSON messages.

    mode=continuous (live interpreter, translates while people speak):
    {"type": "heard", "text"}             newly heard words, to append
    {"type": "translated", "text"}        newly translated words, to append

    mode=sentences (transcribe, then translate each finished sentence):
    {"type": "interim", "text"}           words heard so far in the current sentence
    {"type": "final", "id", "text"}       a finished sentence
    {"type": "translation", "id", "text"} the raw translation reply so far for that sentence

    Both: {"type": "status" | "error", "text"}
    """
    continuous = mode == "continuous"
    await ws.accept()
    audio: asyncio.Queue[bytes | None] = asyncio.Queue(maxsize=300)  # ~30 s of audio
    send_lock = asyncio.Lock()
    history: list[Turn] = []
    ids = itertools.count(1)
    translations: set[asyncio.Task] = set()

    async def send(kind: str, **fields) -> None:
        async with send_lock:
            await ws.send_json({"type": kind, **fields})

    async def read_mic() -> None:
        try:
            while True:
                chunk = await ws.receive_bytes()
                if audio.full():
                    audio.get_nowait()  # drop the oldest chunk rather than fall behind
                audio.put_nowait(chunk)
        except WebSocketDisconnect:
            pass

    async def translate_sentence(sentence_id: int, text: str) -> None:
        req = TranslateRequest(
            text=text, source_lang="auto-detect", target_lang=target, history=history[-6:]
        )
        raw = ""
        async for piece in stream_translation(req):
            raw += piece
            await send("translation", id=sentence_id, text=raw)
        if not raw.startswith("[error"):
            history.append(Turn(source=text, translation=raw.split("</lang>", 1)[-1].strip()))

    async def forward_audio(session) -> None:
        while (chunk := await audio.get()) is not None:
            await session.send_realtime_input(
                audio=types.Blob(data=chunk, mime_type="audio/pcm;rate=16000")
            )

    async def receive_text(session) -> None:
        while True:
            got_any = False
            async for message in session.receive():
                got_any = True
                if message.go_away is not None:
                    return  # server is about to close this session; reconnect
                content = message.server_content
                if not content:
                    continue
                if continuous:
                    heard, translated = content.input_transcription, content.output_transcription
                    if heard and heard.text:
                        await send("heard", text=heard.text)
                    if translated and translated.text:
                        await send("translated", text=translated.text)
                    continue  # the translated audio in model_turn is not used
                interim = content.interim_input_transcription
                if interim and interim.text:
                    await send("interim", text=interim.text)
                final = content.input_transcription
                if final and final.text and final.text.strip():
                    sentence_id = next(ids)
                    await send("final", id=sentence_id, text=final.text.strip())
                    task = asyncio.create_task(translate_sentence(sentence_id, final.text.strip()))
                    translations.add(task)
                    task.add_done_callback(translations.discard)
            if not got_any:
                return  # session closed

    async def transcribe() -> None:
        failures = 0
        while True:
            try:
                model, config = (
                    (INTERPRETER_MODEL, interpreter_config(target_code))
                    if continuous
                    else (LIVE_MODEL, live_config())
                )
                async with get_client().aio.live.connect(model=model, config=config) as session:
                    await send("status", text="listening")
                    failures = 0
                    forwarder = asyncio.create_task(forward_audio(session))
                    try:
                        await asyncio.wait_for(receive_text(session), SESSION_SECONDS)
                    except asyncio.TimeoutError:
                        pass
                    finally:
                        forwarder.cancel()
            except ValueError as e:
                if "API key" not in str(e):
                    raise
                await send("error", text="no Gemini API key; set GEMINI_API_KEY and restart")
                return
            except errors.APIError as e:
                await send("error", text=describe_error(e).strip("[]").removeprefix("error: "))
                if e.code != 429:
                    return
                await asyncio.sleep(15)
            except Exception:
                failures += 1
                log.exception("live session failed")
                if failures >= 3:
                    await send("error", text="lost the connection to Gemini; press Start again")
                    return
                await asyncio.sleep(1)

    mic = asyncio.create_task(read_mic())
    transcriber = asyncio.create_task(transcribe())
    try:
        await asyncio.wait({mic, transcriber}, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for task in (mic, transcriber, *translations):
            task.cancel()
        if transcriber.done() and not transcriber.cancelled() and transcriber.exception():
            log.error("transcriber crashed", exc_info=transcriber.exception())
        try:
            await ws.close()
        except (RuntimeError, WebSocketDisconnect):
            pass  # already closed by the browser
