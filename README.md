# Camayo Data — GitHub + Render

## Abubuwan da ke ciki
- `server.js`: Express API, login/registration, wallet, Paystack verification/webhook, VTpass data purchase.
- `index.html`, `style.css`, `script.js`: web interface.
- SQLite database is created automatically at `DB_PATH` (or `camayo.db` by default).

## Muhimmi kafin a fara
1. Create Paystack and VTpass credentials yourself. Start with provider test/sandbox credentials.
2. Do not share API keys in chat or commit them to GitHub. Put them in Render Environment settings.
3. Real payments and data purchases need valid, enabled provider accounts and successful end-to-end tests.
4. SQLite needs persistent storage. If deploying to Render, attach a persistent disk and set `DB_PATH` to a path on that disk, such as `/var/data/camayo.db`. Without persistent storage, database contents can be lost when the service is replaced/redeployed.

## Run locally
Requires Node.js 20 or newer.

```sh
npm install
cp .env.example .env
```

Edit `.env` and set a strong `JWT_SECRET` (at least 32 characters), then run:

```sh
npm start
```

Open `http://localhost:3000`.

## Publish to GitHub from a phone
1. Sign in to GitHub and create a **new private repository** named `camayo-data`.
2. Upload the project files from this folder. Upload `server.js`, `script.js`, `index.html`, `style.css`, `package.json`, `README.md`, `.gitignore`, and `.env.example`.
3. **Do not upload `.env`, `camayo.db`, or any secret/API key.** `.gitignore` excludes these files if you use Git.

## Deploy on Render
1. Sign in to Render and choose **New → Web Service**.
2. Connect the GitHub repository `camayo-data`.
3. Set **Runtime** to Node; **Build Command** to `npm install`; **Start Command** to `npm start`.
4. In **Environment**, add:
   - `JWT_SECRET` = a newly generated random secret of at least 32 characters
   - `APP_URL` = the HTTPS URL Render assigns to your service, e.g. `https://your-service.onrender.com`
   - `PAYSTACK_SECRET_KEY` = your Paystack test secret initially
   - `VTPASS_API_KEY` and `VTPASS_PUBLIC_KEY` = VTpass credentials
   - `VTPASS_BASE_URL` = `https://vtpass.com/api`
   - `DB_PATH` = `/var/data/camayo.db` (only after attaching a persistent disk mounted at `/var/data`)
5. Create/attach a persistent disk mounted at `/var/data` if the Render plan supports it. If you cannot attach persistent storage, do not use this SQLite setup for real customer balances.
6. Deploy, then open the service URL and test registration, login, plans, wallet funding in test mode, verification, and transaction history.
7. In Paystack dashboard, configure the webhook URL as `https://YOUR-SERVICE.onrender.com/api/paystack/webhook` and test the webhook with provider test tools.
8. Only switch to live keys after the test flow is successful and provider account activation/compliance is complete.

## Current limitations to resolve before real-money launch
- This is a starter deployment package, not proof that provider credentials or live transactions work.
- The app currently uses SQLite; for a high-availability production service, use a managed persistent database and review transaction/refund handling, rate limiting, logging, and operational monitoring.
- Verify the exact VTpass response codes and pending-transaction behavior with VTpass documentation/account before enabling real purchases.
