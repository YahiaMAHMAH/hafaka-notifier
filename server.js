const express = require("express");
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

// The service account key is pasted as a single-line JSON string into the
// SERVICE_ACCOUNT_JSON environment variable on Render (see README.md) —
// never commit the actual key file to git.
const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_JSON);

initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

let isFirstSnapshot = true;

// Same real-time approach as the Cloud Function version — onSnapshot fires
// within ~1 second of a new order being written, no polling delay.
db.collection("orders")
  .where("status", "==", "Preparing")
  .orderBy("timestamp", "desc")
  .limit(25)
  .onSnapshot(
    async (snapshot) => {
      if (isFirstSnapshot) {
        isFirstSnapshot = false;
        return;
      }
      for (const change of snapshot.docChanges()) {
        if (change.type === "added") {
          await notifyDevices({ id: change.doc.id, ...change.doc.data() });
        }
      }
    },
    (err) => console.error("Firestore listener error:", err)
  );

async function notifyDevices(order) {
  const devicesSnap = await db.collection("devices").get();
  if (devicesSnap.empty) {
    console.log("No registered devices — nothing to push.");
    return;
  }

  const itemsText = (order.items || []).map((i) => `${i.qty}x ${i.name}`).join(", ");
  const messages = [];
  devicesSnap.forEach((doc) => {
    const { expoPushToken } = doc.data();
    if (!expoPushToken || !expoPushToken.startsWith("ExponentPushToken")) return;
    messages.push({
      to: expoPushToken,
      sound: "order-alert.wav",
      title: `New order #${order.orderNumber ?? ""} — ${order.customerName || "Customer"}`,
      body: itemsText || (order.total != null ? `${order.total} DA` : "A new order just came in."),
      priority: "high",
      channelId: "orders",
      data: { orderId: order.id },
    });
  });

  if (messages.length === 0) return;

  for (let i = 0; i < messages.length; i += 100) {
    const chunk = messages.slice(i, i + 100);
    await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(chunk),
    });
  }
  console.log(`Pushed order #${order.orderNumber} to ${messages.length} device(s).`);
}

// Render's free tier only stays running if something keeps hitting it —
// this health route is what UptimeRobot (see README.md) pings every 5 min.
const app = express();
app.get("/", (req, res) => res.send("Hafaka notify-server is running."));
app.listen(process.env.PORT || 3000, () => console.log("notify-server up"));
