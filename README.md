# Breeze Bot Tester

Automated frontend test runner for Breeze Payments integrations.
Deployed on **Railway** (no timeout limits), recordings saved to **Google Drive**.

---

## How it works

```
Your browser
    ↕  SSE stream (live logs + results)
Railway (Next.js — full Node.js, no timeouts)
    ↕  WebSocket (Playwright over CDP)
Browserless.io (managed Chromium + screen recording)
    ↕  Google Drive API
Google Drive (dated folder per run, one .webm per test)
```

The bot navigates to the merchant's checkout URL, waits for the Breeze payment
iframe that the merchant's backend already loaded, fills the test card, and
asserts the outcome on the merchant page. No Breeze API key needed.

---

## Deploy to Railway (5 minutes)

### 1. Push code to GitHub

```bash
git clone https://github.com/tim-breeze3/Breeze-Merchant-FE-Automation-Test
cd Breeze-Merchant-FE-Automation-Test

# Copy in the app files from the zip, then:
git add .
git commit -m "Add Breeze bot tester web app"
git push
```

### 2. Create Railway project

1. Go to [railway.app](https://railway.app) → **New Project**
2. Choose **Deploy from GitHub repo**
3. Select `Breeze-Merchant-FE-Automation-Test`
4. Railway detects Next.js automatically via Nixpacks

### 3. Add environment variables

In Railway → your project → **Variables** tab, add:

| Variable | Value |
|---|---|
| `BROWSERLESS_TOKEN` | Your Browserless token |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Full service account JSON (one line) |
| `GOOGLE_DRIVE_FOLDER_ID` | `1KXTuraDwnEEprm0V7FxN6T3BFaEB8MLk` |
| `PORT` | `3000` |

Optional (only if the merchant site requires login):

| Variable | Value |
|---|---|
| `SITE_USER` | Login email/username |
| `SITE_PASSWORD` | Login password |
| `LOGIN_URL` | Login page URL (if different from /login) |

### 4. Deploy

Railway deploys automatically when you push to GitHub.
Every subsequent `git push` triggers a new deploy.

### 5. Get your URL

Railway → your service → **Settings** → **Domains** → Generate Domain.
You'll get a URL like `breeze-bot-tester.up.railway.app`.

---

## Environment variables reference

```bash
# Required
BROWSERLESS_TOKEN=               # from browserless.io/dashboard
GOOGLE_SERVICE_ACCOUNT_JSON=     # full JSON, one line, no line breaks
GOOGLE_DRIVE_FOLDER_ID=          # from Drive folder URL

# Optional — only for gated merchant sites
SITE_USER=
SITE_PASSWORD=
LOGIN_URL=
LOGIN_USER_SELECTOR=input[type="email"]
LOGIN_PASS_SELECTOR=input[type="password"]
LOGIN_SUBMIT_SELECTOR=button[type="submit"]

# Optional — override if Breeze iframe selector differs in this integration
BREEZE_IFRAME_SELECTOR=iframe[src*="breeze"]
BREEZE_SUCCESS_SELECTOR=
BREEZE_FAILURE_SELECTOR=
BREEZE_PAYOUT_SELECTOR=
```

---

## Google Drive setup

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Enable the **Google Drive API**
3. Create a **Service Account** → download JSON key
4. In Google Drive: right-click your recordings folder → **Share** →
   paste the service account email (from `client_email` in the JSON) → **Editor**
5. Copy the folder ID from the Drive URL and set `GOOGLE_DRIVE_FOLDER_ID`

Recordings are organised automatically:
```
📁 Your Drive folder/
  📁 2026-05-11/
    📹 t1-visa-success-us-14h32m.webm
    📹 t5-mastercard-3ds2-14h35m.webm
    📹 FAILED-t3-visa-declined-14h38m.webm
```

---

## Test cards used

| Test | Card | Expected outcome |
|---|---|---|
| Visa success US | `4000020000000000` | ✅ Merchant shows success |
| Visa declined | `4539467987109256` | ❌ Iframe shows decline |
| Visa GB debit | `4659105569051157` | ✅ Merchant shows success |
| Visa prepaid decline | `4000148147058142` | ❌ Iframe shows decline |
| Mastercard 3DS | `5385308360135181` | 🔐 3DS → ✅ success |
| Amex 3DS | `372688581899681` | 🔐 3DS → ✅ success |
| Mastercard FR 3DS | `5137210000000158` | 🔐 3DS → ✅ success |
| Payout | `4000 0566 5566 5556` | ✅ Payout completion |

**3DS simulator password:** `Checkout1!`
