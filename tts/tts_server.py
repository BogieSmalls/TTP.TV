"""
TTP Commentary TTS Service — Kokoro TTS via FastAPI

Runs as a persistent HTTP service. The Node server calls /synthesize to convert
commentary text to WAV audio.

Usage:
  python -m uvicorn tts_server:app --host 127.0.0.1 --port 5123
"""

import io
import sys
import time
from contextlib import asynccontextmanager

import numpy as np
import soundfile as sf
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

# ─── Kokoro Pipeline ───

pipeline = None

AVAILABLE_VOICES = [
    "af_heart",    # American female (warm)
    "af_nice",     # American female (nice)
    "am_adam",     # American male
    "am_michael",  # American male
    "bf_emma",     # British female
    "bf_isabella", # British female
    "bm_george",   # British male
    "bm_lewis",    # British male
]

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Load Kokoro model on startup."""
    global pipeline
    print("[TTS] Loading Kokoro model...", file=sys.stderr, flush=True)
    start = time.time()
    try:
        from kokoro import KPipeline
        pipeline = KPipeline(lang_code='a')  # 'a' = American English
        elapsed = time.time() - start
        print(f"[TTS] Kokoro model loaded in {elapsed:.1f}s", file=sys.stderr, flush=True)
    except Exception as e:
        print(f"[TTS] Failed to load Kokoro: {e}", file=sys.stderr, flush=True)
        # Service runs but /synthesize will return 503
    yield
    print("[TTS] Shutting down", file=sys.stderr, flush=True)


app = FastAPI(lifespan=lifespan)


# ─── Request/Response Models ───

class SynthesizeRequest(BaseModel):
    text: str
    voice: str = "af_heart"
    speed: float = 1.0


# ─── Endpoints ───

@app.get("/health")
async def health():
    return {
        "status": "ok" if pipeline is not None else "loading",
        "model": "kokoro",
        "ready": pipeline is not None,
    }


@app.get("/voices")
async def voices():
    return {"voices": AVAILABLE_VOICES}


@app.post("/synthesize")
async def synthesize(request: SynthesizeRequest):
    if pipeline is None:
        raise HTTPException(503, "TTS model not loaded yet")

    if not request.text.strip():
        raise HTTPException(400, "Empty text")

    if request.voice not in AVAILABLE_VOICES:
        raise HTTPException(400, f"Unknown voice: {request.voice}. Available: {AVAILABLE_VOICES}")

    start = time.time()
    try:
        # Kokoro yields (graphemes, phonemes, audio) tuples per sentence
        audio_segments = []
        for _graphemes, _phonemes, audio in pipeline(
            request.text,
            voice=request.voice,
            speed=request.speed,
        ):
            if audio is not None:
                audio_segments.append(audio)

        if not audio_segments:
            raise HTTPException(500, "No audio generated")

        full_audio = np.concatenate(audio_segments)

        # Write WAV to memory buffer
        buf = io.BytesIO()
        sf.write(buf, full_audio, 24000, format='WAV')
        buf.seek(0)

        elapsed = time.time() - start
        duration_sec = len(full_audio) / 24000
        print(
            f"[TTS] Synthesized {len(request.text)} chars → {duration_sec:.1f}s audio "
            f"in {elapsed:.2f}s (voice={request.voice}, speed={request.speed})",
            file=sys.stderr, flush=True,
        )

        return StreamingResponse(
            buf,
            media_type="audio/wav",
            headers={
                "X-Audio-Duration-Ms": str(int(duration_sec * 1000)),
                "X-Synthesis-Ms": str(int(elapsed * 1000)),
            },
        )

    except HTTPException:
        raise
    except Exception as e:
        elapsed = time.time() - start
        print(f"[TTS] Synthesis error after {elapsed:.2f}s: {e}", file=sys.stderr, flush=True)
        raise HTTPException(500, f"Synthesis failed: {e}")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=5123)
