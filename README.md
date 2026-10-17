# Daywell

A lightweight voice-first wellness coach. Sarvam handles code-mixed speech recognition, coaching, and spoken replies. Your check-ins and preferences stay in this browser's local storage; audio and conversation text are sent to Sarvam when you use the coach.

## Run locally

```bash
python -m pip install -r requirements.txt
```

Add your key to `.env` in this folder:

```text
SARVAM_API_KEY=your_key_here
```

Start the app:

```bash
python chat.py
```

Open [http://127.0.0.1:8000](http://127.0.0.1:8000). Microphone access is available on localhost in a supported browser. Use Settings to set goals and reminder times; browser notifications are optional and only run while the app is open.

## Notes

- Food calories and macros are AI estimates, not nutrition-label readings.
- Conversation history is stored in this browser only. Use **Clear my history** in Settings to remove it.
- The server binds to `127.0.0.1` by default. Set `PORT` to use a different local port.