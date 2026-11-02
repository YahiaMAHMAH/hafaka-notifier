"use strict";
/*
 * Restaurant driver notify-server v2.
 * Watches every configured restaurant's Firestore and pushes new delivery
 * orders to that restaurant's available drivers through Expo Push.
 * See README.md for configuration.
 */
const express = require("express");
const admin = require("firebase-admin");

const EXPO_SEND = "https://exp.host/--/api/v2/push/send";
const EXPO_RECEIPTS = "https://exp.host/--/api/v2/push/getReceipts";
const CHANNEL_ID = process.env.CHANNEL_ID || "orders_v1";
const SOUND = process.env.SOUND || "order_alert.wav";
const CATCHUP_MIN = Number(process.env.CATCHUP_MINUTES || 10);
const REMINDERS_SEC = (process.env.REMINDERS_SEC || "60,180")
  .split(",").map(Number).filter((n) => n > 0);
const RECEIPT_DELAY_MS = 15 * 60 * 1000;

const log = (id, ...a) => console.log(`[${new Date().toISOString()}] [${id}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));

// ── Which orders go to drivers ────────────────────────────────────────────
// Mirrors the sites: table QR orders and pickup / dine-in are never delivered.
// An order with no orderType (Hafaka) counts as delivery.
function isDelivery(o) {
  if (o.tableNumber) return false;
  const t = String(o.orderType || o.deliveryType || "").trim();
  if (/^table\b/i.test(t)) return false;
  if (/sur place|emporter|take.?away|pick.?up|dine/i.test(t)) return false;
  return true;
}

// ── Config ────────────────────────────────────────────────────────────────
function loadConfig() {
  try {
    if (process.env.RESTAURANTS_JSON) return JSON.parse(process.env.RESTAURANTS_JSON);
    if (process.env.SERVICE_ACCOUNT_JSON) {
      // Backward compatible with the v1 single-restaurant deploy.
      return [{ id: "hafaka", name: "Hafaka Burgers", serviceAccount: JSON.parse(process.env.SERVICE_ACCOUNT_JSON) }];
    }
  } catch (e) {
    console.error("Config JSON is invalid:", e.message);
  }
  console.error("No restaurants configured. Set RESTAURANTS_JSON (see README.md).");
  return [];
}

async function expoPost(url, body) {
  const headers = { Accept: "application/json", "Content-Type": "application/json" };
  if (process.env.EXPO_ACCESS_TOKEN) headers.Authorization = `Bearer ${process.env.EXPO_ACCESS_TOKEN}`;
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Expo ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// ── One restaurant ────────────────────────────────────────────────────────
function startRestaurant(cfg) {
  const st = {
    id: cfg.id, name: cfg.name || cfg.id,
    drivers: new Map(),   // uid -> users doc (role == driver)
    devices: new Map(),   // device doc id -> { uid, expoPushToken }
    pending: new Map(),   // orderId -> order (status == Preparing)
    ordersLive: false, errors: 0, lastPushAt: null,
  };
  let db;
  try {
    const app = admin.initializeApp({ credential: admin.credential.cert(cfg.serviceAccount) }, cfg.id);
    db = app.firestore();
  } catch (e) {
    log(cfg.id, "init failed:", e.message);
    st.errors++;
    return st;
  }

  // Listener with automatic re-listen. onSnap(snap, isFirst) — isFirst is true
  // again after every re-listen, which is what triggers catch-up.
  function watch(label, query, onSnap, onError) {
    let delay = 2000;
    let resolveReady;
    const ready = new Promise((r) => (resolveReady = r));
    const run = () => {
      let first = true;
      query.onSnapshot(
        (snap) => {
          delay = 2000;
          try { onSnap(snap, first); } catch (e) { log(cfg.id, label, "handler error:", e.message); }
          if (first) { first = false; resolveReady(); }
        },
        (err) => {
          st.errors++;
          if (onError) onError();
          log(cfg.id, label, "listener error, retry in", delay, "ms:", err.message);
          setTimeout(run, delay);
          delay = Math.min(delay * 2, 60000);
        }
      );
    };
    run();
    return ready;
  }

  async function dropDevice(token) {
    for (const [id, d] of st.devices) {
      if (d.expoPushToken === token) {
        await db.collection("devices").doc(id).delete().catch(() => {});
        st.devices.delete(id);
        log(cfg.id, "removed dead device", id);
      }
    }
  }

  async function checkReceipts(ids) {
    try {
      const out = await expoPost(EXPO_RECEIPTS, { ids: Object.keys(ids) });
      for (const [rid, r] of Object.entries(out.data || {})) {
        if (r.status === "error") {
          log(cfg.id, "receipt error:", r.details && r.details.error, r.message);
          if (r.details && r.details.error === "DeviceNotRegistered") await dropDevice(ids[rid]);
        }
      }
    } catch (e) { log(cfg.id, "receipt check failed:", e.message); }
  }

  async function pushOrder(o, kind) {
    const byToken = new Map();
    for (const [id, dev] of st.devices) {
      const token = dev.expoPushToken;
      if (!token || !/^Expo(nent)?PushToken\[/.test(token)) continue;
      const uid = dev.uid || id.split("_")[0];
      const u = st.drivers.get(uid);
      if (!u || u.active === false || u.available === false) continue;
      if ((o.deniedBy || []).includes(uid)) continue;
      byToken.set(token, id);
    }
    if (!byToken.size) { log(cfg.id, `order ${o.id}: no available driver devices`); return 0; }

    const items = o.items || [];
    const itemsText = items.slice(0, 3).map((i) => `${i.qty}x ${i.name}`).join(", ") + (items.length > 3 ? "…" : "");
    const body = [o.customerName, itemsText, o.total != null ? `${o.total} DA` : ""].filter(Boolean).join(" · ");
    const title = `${st.name} — ${kind === "reminder" ? "Commande en attente" : "Nouvelle commande"}`;
    const tokens = [...byToken.keys()];
    const receiptIds = {};
    let sent = 0;

    for (let i = 0; i < tokens.length; i += 100) {
      const chunk = tokens.slice(i, i + 100);
      try {
        const out = await expoPost(EXPO_SEND, chunk.map((to) => ({
          to, title, body, sound: SOUND, priority: "high", channelId: CHANNEL_ID, ttl: 600,
          data: { type: "new_order", restaurantId: cfg.id, orderId: o.id },
        })));
        (out.data || []).forEach((t, k) => {
          if (t.status === "ok") { sent++; if (t.id) receiptIds[t.id] = chunk[k]; }
          else {
            log(cfg.id, "ticket error:", t.details && t.details.error, t.message);
            if (t.details && t.details.error === "DeviceNotRegistered") dropDevice(chunk[k]);
          }
        });
      } catch (e) { log(cfg.id, "push send failed:", e.message); }
    }
    if (Object.keys(receiptIds).length) setTimeout(() => checkReceipts(receiptIds), RECEIPT_DELAY_MS);
    st.lastPushAt = Date.now();
    log(cfg.id, `order ${o.id} (${kind}): pushed to ${sent}/${tokens.length} device(s)`);
    return sent;
  }

  // Exactly-once per order, even across restarts or two overlapping instances:
  // create() on push_log/{orderId} fails if it already exists.
  async function announce(o) {
    try {
      await db.collection("push_log").doc(o.id).create({
        restaurant: cfg.id, firstAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (e) {
      if (e.code === 6 || /ALREADY_EXISTS/i.test(e.message)) return;
      log(cfg.id, "push_log create failed:", e.message);
      return;
    }
    await pushOrder(o, "new");
    for (const s of REMINDERS_SEC) {
      setTimeout(() => {
        const cur = st.pending.get(o.id);   // gone = claimed, cancelled or deleted
        if (cur) pushOrder(cur, "reminder");
      }, s * 1000);
    }
  }

  (async () => {
    const usersReady = watch("users",
      db.collection("users").where("role", "==", "driver"),
      (snap) => { st.drivers = new Map(snap.docs.map((d) => [d.id, d.data()])); });
    const devicesReady = watch("devices",
      db.collection("devices"),
      (snap) => { st.devices = new Map(snap.docs.map((d) => [d.id, d.data()])); });
    // Orders are processed only after drivers and devices are loaded.
    await Promise.race([Promise.all([usersReady, devicesReady]), sleep(15000)]);

    watch("orders",
      db.collection("orders").where("status", "==", "Preparing"),
      (snap, first) => {
        st.ordersLive = true;
        st.pending = new Map(snap.docs.map((d) => [d.id, { id: d.id, ...d.data() }]));
        for (const ch of snap.docChanges()) {
          if (ch.type !== "added") continue;
          const o = { id: ch.doc.id, ...ch.doc.data() };
          if (!isDelivery(o)) continue;
          if (first) {   // start-up / re-listen: only recent orders, never old ones
            const ts = o.timestamp && o.timestamp.toMillis ? o.timestamp.toMillis() : 0;
            if (!ts || Date.now() - ts > CATCHUP_MIN * 60000) continue;
          }
          announce(o);
        }
      },
      () => { st.ordersLive = false; });
    log(cfg.id, "watching");
  })();

  return st;
}

// ── Boot ──────────────────────────────────────────────────────────────────
const restaurants = loadConfig().map(startRestaurant);

const app = express();
app.get("/", (req, res) => res.send("notify-server is running."));
// UptimeRobot pings this. 503 when any restaurant's order listener is down,
// so the monitor emails you.
app.get("/health", (req, res) => {
  const out = restaurants.map((r) => ({
    id: r.id, listening: r.ordersLive, pending: r.pending.size,
    drivers: r.drivers.size, devices: r.devices.size,
    errors: r.errors, lastPushAt: r.lastPushAt ? new Date(r.lastPushAt).toISOString() : null,
  }));
  res.status(out.every((r) => r.listening) ? 200 : 503).json(out);
});
app.listen(process.env.PORT || 3000, () => console.log("notify-server up,", restaurants.length, "restaurant(s)"));
