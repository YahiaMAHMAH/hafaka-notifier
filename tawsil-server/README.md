# Tawsil server (v2)

Watches the Firestore of every configured restaurant and sends a push notification to that restaurant's available drivers when a new delivery order arrives. It replaces the v1 single-restaurant server and runs on the same free Render service.

## What it does

- Listens to `orders` where `status == "Preparing"` for each restaurant.
- Sends only delivery orders. Orders with a `tableNumber`, or an `orderType` such as "Table 4", "Sur place" or "À emporter", are skipped. An order with no `orderType` counts as delivery.
- Sends only to drivers who are active, available, and have not denied the order. Admins never receive these pushes.
- Sends each order exactly once, even across restarts or overlapping deploys, using a `push_log/{orderId}` document.
- After a restart or a lost connection it catches up on orders created in the last 10 minutes.
- Sends reminders at 60 and 180 seconds while the order is still unclaimed.
- Removes dead push tokens from `devices`.
- Re-listens automatically after a Firestore listener error.

## Configuration

Set one environment variable, `RESTAURANTS_JSON`, on Render. See `restaurants.example.json`. It is a JSON array, pasted as a single line:

    [{"id":"hafaka","name":"Hafaka Burgers","serviceAccount":{...}},{"id":"migusto","name":"Migusto","serviceAccount":{...}}]

Each `serviceAccount` is the private key file from Firebase Console, Project settings, Service accounts, Generate new private key. Never commit it to git.

For backward compatibility, if `RESTAURANTS_JSON` is missing and the old `SERVICE_ACCOUNT_JSON` is set, the server runs as the single restaurant "hafaka".

Optional variables: `CHANNEL_ID` (default `orders_v1`), `SOUND` (default `order_alert.wav`), `CATCHUP_MINUTES` (default 10), `REMINDERS_SEC` (default `60,180`, empty value disables), `EXPO_ACCESS_TOKEN`.

## Deploy

Push these files to the existing `hafaka-notifier` GitHub repo, then rename the repo to `tawsil-server`. Render auto-deploys. Build command `npm install`, start command `npm start`.

## Keep it awake and monitored

In UptimeRobot, set an HTTP monitor on `https://<your-service>.onrender.com/health` every 5 minutes with email alerts. `/health` returns 200 when every restaurant's order listener is live and 503 when one is down, so a broken listener sends you an email.

## What each restaurant site needs

1. A `/devices` rule that ties each device to its owner. Replace the existing rule (Hafaka) or add it (Migusto):

        match /devices/{id} {
          allow read: if isAdmin();
          allow create, update: if isStaff()
                                && request.resource.data.expoPushToken is string
                                && request.resource.data.uid == request.auth.uid
                                && id.matches(request.auth.uid + '(_.*)?');
          allow delete: if isStaff() && (resource.data.get('uid', '') == request.auth.uid || isAdmin());
        }

2. `push_log` needs no rule. Only the server writes it, through the Admin SDK. Check that the rules file ends with a default deny for unlisted collections.
3. No composite index is needed. The queries use one field each.

## Test

Place a delivery order on the site while a driver device is registered and available. The Render logs show `order <id> (new): pushed to 1/1 device(s)`.
