# VICTOR AI backend

This is a real persistent FastAPI backend matching the routes recovered from `VICTOR-AI-release.apk`. It uses SQLite by default, stores recordings under `DATA_DIR`, encrypts provider secrets with AES-256-GCM when `SECRET_ENCRYPTION_KEY` is set, and refuses provider calls when a key is absent instead of returning fake data.

## Local setup

```bash
cd victor-backend
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
python3 - <<'PY'
from cryptography.fernet import Fernet
print(Fernet.generate_key().decode())
PY
# put the generated value in SECRET_ENCRYPTION_KEY
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Open `http://127.0.0.1:8000/api/health`. For the Android APK, deploy behind HTTPS and enter that HTTPS URL in the app's server settings. Do not use a LAN HTTP URL in the production APK.

## Docker

```bash
cp .env.example .env
# set APP_PIN, CORS_ORIGINS, SECRET_ENCRYPTION_KEY and provider credentials
mkdir -p data
sudo docker build -t victor-backend .
sudo docker run --rm -p 8000:8000 --env-file .env -v "$PWD/data:/app/data" victor-backend
```

Use a reverse proxy such as Caddy or a managed HTTPS service for production. Set `CORS_ORIGINS` to the exact app/browser origins, not `*`. Set `WHATSAPP_VERIFY_TOKEN` and `WHATSAPP_APP_SECRET` before configuring Meta. WhatsApp messaging is disabled until the owner explicitly sets `WHATSAPP_AUTO_REPLY=true`.

## Provider notes

Gemini uses the official `generativelanguage.googleapis.com` REST API. The verified GonkaRouter-compatible setup is:

```text
AI_PROVIDER=gonka
GONKA_BASE_URL=https://api.gonkarouter.io/v1
GONKA_MODEL=MiniMaxAI/MiniMax-M2.7
GONKA_API_KEY=your-server-side-key
```

The equivalent generic names are `AI_PROVIDER=compatible`, `OPENAI_COMPAT_BASE_URL`, `OPENAI_COMPAT_MODEL`, and `OPENAI_COMPAT_API_KEY`. GonkaRouter and Hugging Face use OpenAI-compatible `/chat/completions` endpoints. Provider fallback is **off by default** and must be explicitly enabled with `ENABLE_PROVIDER_FALLBACK=true`; the backend never silently changes provider when fallback is disabled. It reports the actual provider/model and returns explicit errors for missing keys, timeouts, quotas, malformed replies, and upstream outages. The automated tests do not send a live provider request because no GonkaRouter key is present in this environment.

## Security and data

The app PIN protects API routes. Secrets are encrypted at rest with AES-GCM using `SECRET_ENCRYPTION_KEY`; losing that key makes stored secrets unrecoverable. The database contains settings, messages, activities, recordings metadata, transcripts, summaries, and reports. Audio is stored on disk under `DATA_DIR/audio`. `DELETE /api/recordings/{id}` removes metadata and audio. Retention purge removes expired recordings. Keep the data directory private and back it up using your hosting provider's encrypted backup facility.

## Known external blockers

This backend cannot create Meta accounts, grant WhatsApp permissions, establish calling eligibility, or prove that a particular country/number supports WhatsApp Business Calling. The calling routes therefore report prerequisites and remain disabled until the owner configures an eligible deployment. Physical Android microphone and APK installation tests require a real device or emulator.
