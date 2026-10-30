"""Live translation server: serves the page and streams Gemini translations."""

import os
from pathlib import Path

from fastapi import FastAPI
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


@app.get("/")
async def index():
    return FileResponse(STATIC / "index.html")


@app.post("/api/translate")
async def translate(req: TranslateRequest):
    async def chunks():
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
            if e.code == 429:
                yield "[error: free-tier limit reached, wait a minute and try again]"
            elif e.code in (400, 401, 403) and "key" in str(e).lower():
                yield "[error: invalid Gemini API key]"
            else:
                yield f"[error: Gemini API returned {e.code}]"

    return StreamingResponse(chunks(), media_type="text/plain; charset=utf-8")
