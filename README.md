# Pembrey Sands tactical landing watcher

This project is now focused on a single use case: monitoring UK NOTAM data for Pembrey Sands tactical landing activity and alerting when something new appears.

## What it does

- downloads the latest NOTAM feed
- filters for Pembrey-related notices
- ignores already-seen items using a local state file
- extracts the relevant time/altitude information from the NOTAM text
- checks a tide source to estimate a likely low-tide window
- uses OpenAI for a concise, plane-spotter-friendly summary
- sends the alert to a configured Telegram chat

## How to run

```bash
npm run pembrey-watch
```

## Environment variables

```bash
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o-mini
NOTAM_URL=
STATE_FILE=./data/pembrey-state.json
OUTPUT_FILE=./data/pembrey-notam.json
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
TELEGRAM_MESSAGE_THREAD_ID=
TIDE_URL=https://www.tide-forecast.com/locations/Pembroke-Dock/tides/latest
```

## Scheduling

Use a cron job or GitHub Actions schedule to run this periodically, for example every 30 minutes or every 2 hours.
