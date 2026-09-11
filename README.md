# Hafaka notify-server (free, no card required)

Replaces the Cloud Function. Does the exact same job — watches the `orders`
collection and pushes a sound notification to every phone in `devices` — but
runs as a small always-on Node process instead of a Firebase Cloud Function,
so it stays on Firebase's free **Spark** plan (no Blaze, no card).

## 1. Get a service account key (free, no card)
Firebase Console → ⚙️ Project Settings → **Service accounts** tab →
**Generate new private key**. Downloads a `.json` file. Keep it private —
never commit it to GitHub.

## 2. Create a free Render account
render.com → sign up (no card needed for the free tier).

## 3. Deploy
- New → **Web Service**
- Connect the `notify-server` folder (push it to its own small GitHub repo,
  or use Render's "public git repo" / manual deploy option)
- Build command: `npm install`
- Start command: `npm start`
- Instance type: **Free**
- Add an environment variable:
  - Key: `SERVICE_ACCOUNT_JSON`
  - Value: the ENTIRE contents of the `.json` file from step 1, pasted as
    one line (open the file, copy everything, paste as the value)

Deploy. Once live, Render gives you a URL like
`https://hafaka-notify-server.onrender.com`.

## 4. Keep it awake (free tier sleeps after 15 min idle)
Render's free web services spin down without traffic. Fix with a free
uptime pinger:
- uptimerobot.com → free account → **Add New Monitor**
- Monitor type: HTTP(s)
- URL: your Render URL from step 3
- Interval: every 5 minutes

This keeps the listener alive 24/7 for $0 — Render's free tier includes
750 hours/month, more than enough for one always-on service.

## 5. Confirm it's working
Render dashboard → Logs tab → you should see `notify-server up`. Create a
test order (status: "Preparing") in Firestore and watch for
`Pushed order #... to N device(s).` in the logs within a second or two.

## Trade-offs vs. the Cloud Function version
- Same real-time speed (Firestore listener, not polling).
- Slight risk: if Render has downtime or the free instance restarts,
  there's a brief gap before it reconnects — rare, but worth knowing.
- If you ever add a card later, switching back to the Cloud Function
  (`functions/index.js`, already in this project) takes 5 minutes and is
  slightly more reliable long-term.
