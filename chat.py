import base64
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from sarvamai import SarvamAI

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
MAX_BODY_BYTES = 10 * 1024 * 1024
SYSTEM_PROMPT = """You are a practical, kind wellness coach. Be concise, encouraging, and never shame the user. Follow their requested language, including natural English-Indian language code-mixing. Do not diagnose, prescribe, or make medical claims. Treat all nutrition figures as estimates and say so when relevant. Adapt suggestions to the user's goals, recent progress, sleep, and reported energy. Prefer small realistic next steps. If they mention food, a workout, sleep, or energy, record it in entries. Do not invent details they did not provide.
Return only a JSON object with this shape:
{"reply":"short conversational response","entries":[{"type":"meal|workout|sleep|energy","label":"short description","calories":0,"protein_g":0,"carbs_g":0,"fat_g":0,"minutes":0,"hours":0,"energy":0}],"recommendation":"one optional next step"}
Only include numeric fields that can reasonably be estimated from what the user said. Use an empty entries array when there is nothing to log. Energy is an integer from 1 to 5. Calories and macros should be estimates, never false precision."""


def load_api_key():
    api_key = os.environ.get("SARVAM_API_KEY")
    if api_key:
        return api_key
    env_file = ROOT / ".env"
    if not env_file.exists():
        return None
    for line in env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line.startswith("SARVAM_API_KEY="):
            return line.split("=", 1)[1].strip().strip("'\"")
    return None


API_KEY = load_api_key()
CLIENT = SarvamAI(api_subscription_key=API_KEY) if API_KEY else None


def json_number(value, minimum=0, maximum=10000):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if not minimum <= value <= maximum:
        return None
    return round(value, 1)


def clean_entries(entries):
    if not isinstance(entries, list):
        return []
    cleaned = []
    for entry in entries[:8]:
        if not isinstance(entry, dict) or entry.get("type") not in {"meal", "workout", "sleep", "energy"}:
            continue
        item = {"type": entry["type"], "label": str(entry.get("label", ""))[:120]}
        for field, bounds in {
            "calories": (0, 10000),
            "protein_g": (0, 1000),
            "carbs_g": (0, 1000),
            "fat_g": (0, 1000),
            "minutes": (0, 1440),
            "hours": (0, 24),
            "energy": (1, 5),
        }.items():
            number = json_number(entry.get(field), *bounds)
            if number is not None:
                item[field] = number
        cleaned.append(item)
    return cleaned


def normalize_audio_mime(value):
    mime = str(value or "audio/webm").lower().split(";", 1)[0].strip()
    supported = {
        "audio/webm", "video/webm", "audio/ogg", "audio/opus", "audio/mp4",
        "audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/aac",
        "audio/flac", "audio/amr", "application/octet-stream",
    }
    return mime if mime in supported else "audio/webm"


class WellnessHandler(BaseHTTPRequestHandler):
    def send_json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > MAX_BODY_BYTES:
            raise ValueError("Request body is missing or too large.")
        return json.loads(self.rfile.read(length))

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/status":
            return self.send_json({"configured": CLIENT is not None})
        relative = "index.html" if path == "/" else path.removeprefix("/static/")
        if path != "/" and not path.startswith("/static/"):
            return self.send_json({"error": "Not found."}, 404)
        file_path = (STATIC / relative).resolve()
        if STATIC.resolve() not in file_path.parents or not file_path.is_file():
            return self.send_json({"error": "Not found."}, 404)
        content_type = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "text/javascript; charset=utf-8",
        }.get(file_path.suffix, "application/octet-stream")
        body = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if CLIENT is None:
            return self.send_json({"error": "Add SARVAM_API_KEY to .env to enable voice coaching."}, 503)
        try:
            payload = self.read_json()
            path = urlparse(self.path).path
            if path == "/api/chat":
                return self.chat(payload)
            if path == "/api/transcribe":
                return self.transcribe(payload)
            if path == "/api/speak":
                return self.speak(payload)
            return self.send_json({"error": "Not found."}, 404)
        except ValueError as error:
            return self.send_json({"error": str(error)}, 400)
        except Exception as error:
            return self.send_json({"error": f"Sarvam request failed: {error}"}, 502)

    def chat(self, payload):
        text = str(payload.get("text", "")).strip()[:3000]
        if not text:
            return self.send_json({"error": "Say or type a little about your day first."}, 400)
        context = payload.get("context", {})
        context_text = json.dumps(context, ensure_ascii=False)[:6000]
        messages = [{"role": "system", "content": SYSTEM_PROMPT}]
        history = payload.get("history", [])
        if isinstance(history, list):
            for item in history[-10:]:
                if isinstance(item, dict) and item.get("role") in {"user", "assistant"}:
                    content = str(item.get("content", ""))[:1200]
                    if content:
                        messages.append({"role": item["role"], "content": content})
        messages.append({
            "role": "user",
            "content": f"Current wellness context (use as background, do not repeat it): {context_text}\n\n{text}",
        })
        result = CLIENT.chat.completions(
            model="sarvam-105b-conversations",
            messages=messages,
            temperature=0.4,
            max_tokens=700,
            response_format={"type": "json_object"},
        )
        raw = result.choices[0].message.content or "{}"
        try:
            answer = json.loads(raw)
        except json.JSONDecodeError:
            answer = {"reply": raw, "entries": [], "recommendation": ""}
        if not isinstance(answer, dict):
            answer = {}
        return self.send_json({
            "reply": str(answer.get("reply", "Got it. I’ve updated your day."))[:1200],
            "entries": clean_entries(answer.get("entries")),
            "recommendation": str(answer.get("recommendation", ""))[:300],
        })

    def transcribe(self, payload):
        audio = str(payload.get("audio", ""))
        if "," in audio and audio.startswith("data:"):
            audio = audio.split(",", 1)[1]
        audio_bytes = base64.b64decode(audio, validate=True)
        if not audio_bytes or len(audio_bytes) > 7 * 1024 * 1024:
            return self.send_json({"error": "That recording is empty or too long. Try a shorter check-in."}, 400)
        mime = normalize_audio_mime(payload.get("mime"))
        codec = next((item for item in ("webm", "ogg", "mp4", "wav", "m4a") if item in mime), "webm")
        result = CLIENT.speech_to_text.transcribe(
            file=(f"recording.{codec}", audio_bytes, mime),
            model="saaras:v3",
            mode="codemix",
            language_code="unknown",
        )
        return self.send_json({"transcript": result.transcript or ""})

    def speak(self, payload):
        text = str(payload.get("text", "")).strip()[:800]
        if not text:
            return self.send_json({"error": "There is no reply to speak."}, 400)
        language = str(payload.get("language", "en-IN"))
        if language not in {"en-IN", "hi-IN", "ta-IN", "te-IN", "kn-IN", "ml-IN", "mr-IN", "bn-IN"}:
            language = "en-IN"
        result = CLIENT.text_to_speech.convert(
            text=text,
            model="bulbul:v3",
            language_code=language,
            speaker="ishita",
            pace=0.85,
            output_audio_codec="mp3",
        )
        return self.send_json({"audio": result.audios[0], "mime": "audio/mpeg"})

    def log_message(self, format, *args):
        if "/api/" not in str(args[0] if args else ""):
            super().log_message(format, *args)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    server = ThreadingHTTPServer(("127.0.0.1", port), WellnessHandler)
    print(f"Wellness Coach ready at http://127.0.0.1:{port}")
    print("Sarvam API key: configured" if CLIENT else "Sarvam API key: missing (.env or environment)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nWellness Coach stopped.")
    finally:
        server.server_close()
