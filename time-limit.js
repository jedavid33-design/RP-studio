/* RP Studio daily active-time allowance: 60 minutes across cloud-synced devices.
   Uses a separate encrypted, revision-checked /sync document, never the story library.
   No in-app override or extension. Cloud verification is required (fail closed). */
(() => {
  "use strict";
  const LIMIT = 60 * 60 * 1000;
  const IDLE = 2 * 60 * 1000;
  const POLL = 5000;
  const DEVICE_KEY = "rp.timeLimit.device.v1";
  const LOCAL_KEY = "rp.timeLimit.usage.v1";
  const ctx = {
    mode: "loading", reason: "", id: "", key: null, day: "", device: "",
    localMs: 0, othersMs: 0, lastTick: Date.now(), lastActivity: Date.now(),
    visible: !document.hidden, lastPoll: 0, busy: false, generation: 0, connection: ""
  };

  const style = document.createElement("style");
  style.textContent = [
    "#rp-time-badge{display:inline-block;font-size:11px;margin-top:4px;color:#684879;font-weight:650;letter-spacing:0}",
    "#rp-time-shield{position:fixed;inset:0;background:rgba(31,17,39,.95);z-index:2147483640;display:flex;justify-content:center;align-items:center;padding:20px;box-sizing:border-box}",
    "#rp-time-shield[hidden]{display:none!important}",
    "#rp-time-card{width:min(100%,430px);background:#fbf6ff;color:#392747;border-radius:24px;padding:30px 25px;text-align:center;box-shadow:0 15px 65px #0005;font-family:system-ui,-apple-system,sans-serif}",
    "#rp-time-card h2{font-size:24px;margin:10px 0 12px}",
    "#rp-time-card p{font-size:15px;line-height:1.5;margin:9px 0;color:#53435c}",
    "#rp-time-card .rp-time-icon{font-size:32px}",
    "#rp-time-card button{border:0;border-radius:12px;background:#684879;color:white;padding:13px 19px;margin-top:12px;font-weight:650;font-size:15px}",
    "#rp-time-card button[hidden]{display:none}"
  ].join("");
  document.head.appendChild(style);
  const shield = document.createElement("section");
  shield.id = "rp-time-shield";
  shield.setAttribute("role", "dialog");
  shield.setAttribute("aria-modal", "true");
  shield.setAttribute("aria-labelledby", "rp-time-title");
  shield.innerHTML = '<div id="rp-time-card"><div class="rp-time-icon">⏳</div><h2 id="rp-time-title">Checking today’s time</h2><p id="rp-time-message">Verifying your shared daily allowance…</p><p>60 minutes of active time each day, shared across your devices. The timer pauses after 2 minutes without activity.</p><p>Resets at midnight Eastern. No extensions.</p><button id="rp-time-retry" type="button" hidden>Retry connection</button><button id="rp-time-setup" type="button" hidden>Open sync settings</button></div>';
  document.body.appendChild(shield);
  const badge = document.createElement("div");
  badge.id = "rp-time-badge";
  badge.setAttribute("aria-live", "off");
  const header = document.querySelector(".topbar .title-wrap") || document.querySelector(".topbar") || document.body;
  header.appendChild(badge);

  function easternDay(now = Date.now()) {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit"
    }).formatToParts(now).filter(item => item.type !== "literal").map(item => [item.type, item.value]));
    return p.year + "-" + p.month + "-" + p.day;
  }
  function remaining() {
    return Math.max(0, LIMIT - ctx.othersMs - ctx.localMs);
  }
  function total() {
    return ctx.othersMs + ctx.localMs;
  }
  function fmt(ms) {
    const minutes = Math.ceil(Math.max(0, ms) / 60000);
    return minutes >= 60 ? "1h" : minutes + "m";
  }
  function setMode(mode, message = "") {
    ctx.mode = mode;
    ctx.reason = message;
    render();
  }
  function render() {
    const canUse = ctx.mode === "ready" && remaining() > 0;
    shield.hidden = canUse;
    badge.textContent = ctx.mode === "ready" || ctx.mode === "limit"
      ? "⏳ " + fmt(remaining()) + " of 1h left today"
      : "⏳ Time check needed";
    document.getElementById("rp-time-retry").hidden = ctx.mode !== "offline";
    document.getElementById("rp-time-setup").hidden = ctx.mode !== "setup";
    const title = document.getElementById("rp-time-title");
    const message = document.getElementById("rp-time-message");
    if (ctx.mode === "limit" || (ctx.mode === "ready" && !remaining())) {
      title.textContent = "That’s your hour for today 💜";
      message.textContent = "Your 60 active minutes have been used across RP Studio devices. Your story is saved. Come back after midnight Eastern.";
    } else if (ctx.mode === "setup") {
      title.textContent = "Connect your devices first";
      message.textContent = "A shared, non-overridable limit requires RP Studio Private Cloud Sync on this device. Connect with the same sync code on iPhone and iPad.";
    } else if (ctx.mode === "offline") {
      title.textContent = "Time check unavailable";
      message.textContent = ctx.reason || "RP Studio is paused until it can verify your remaining time online. Your stories are safe.";
    } else {
      title.textContent = "Checking today’s time";
      message.textContent = "Verifying your allowance with the cloud…";
    }
  }
  function storageGet(key) {
    try { return localStorage.getItem(key); } catch { throw new Error("Browser storage is unavailable."); }
  }
  function storageSet(key, value) {
    try { localStorage.setItem(key, value); }
    catch { throw new Error("Unable to save the time counter on this device."); }
  }
  function saveLocal() {
    storageSet(LOCAL_KEY, JSON.stringify({
      syncId: ctx.id, day: ctx.day, device: ctx.device, usedMs: Math.ceil(ctx.localMs)
    }));
  }
  function resetLocalForDay(day) {
    ctx.day = day;
    ctx.othersMs = 0;
    let cached = null;
    try { cached = JSON.parse(storageGet(LOCAL_KEY) || "null"); } catch { /* no usable cache */ }
    ctx.localMs = cached && cached.syncId === ctx.id && cached.day === day &&
      cached.device === ctx.device && Number.isFinite(cached.usedMs)
        ? Math.max(0, cached.usedMs) : 0;
    saveLocal();
  }
  function recordElapsed(now = Date.now()) {
    if (easternDay(now) !== ctx.day && ctx.day) {
      try {
        resetLocalForDay(easternDay(now));
        setMode("loading");
      } catch (e) { setMode("offline", e.message); }
      ctx.lastTick = now;
      ctx.lastActivity = now;
      void syncOnce();
      return;
    }
    if (ctx.visible && ctx.mode === "ready") {
      const until = Math.min(now, ctx.lastActivity + IDLE);
      const delta = Math.max(0, until - ctx.lastTick);
      if (delta > 0) {
        ctx.localMs += Math.min(delta, remaining());
        try { saveLocal(); } catch (error) { setMode("offline", error.message); }
        if (total() >= LIMIT) setMode("limit");
      }
    }
    ctx.lastTick = now;
    if (ctx.mode === "ready") render();
  }
  function makeDeviceId() {
    let id = storageGet(DEVICE_KEY);
    if (!id) {
      id = crypto.randomUUID ? crypto.randomUUID() : encodeBase64Url(crypto.getRandomValues(new Uint8Array(24)));
      storageSet(DEVICE_KEY, id);
    }
    return id;
  }
  async function initialize() {
    const generation = ++ctx.generation;
    ctx.lastTick = Date.now();
    ctx.lastActivity = ctx.lastTick;
    ctx.visible = !document.hidden;
    ctx.lastPoll = 0;
    ctx.othersMs = 0;
    ctx.connection = [cloudSync.code, state.settings.workerUrl, state.settings.appPassword].join("|");
    ctx.key = null;
    ctx.id = "";
    setMode("loading");
    if (!cloudSync.enabled || !cloudSync.code || !state.settings.workerUrl || !state.settings.appPassword) {
      setMode("setup");
      return;
    }
    try {
      ctx.device = makeDeviceId();
      const material = await syncMaterial(cloudSync.code);
      const input = new TextEncoder().encode("rp-studio-active-time-v1:" + material.code);
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
      if (generation !== ctx.generation) return;
      ctx.id = encodeBase64Url(digest);
      ctx.key = material.key;
      resetLocalForDay(easternDay());
      await syncOnce();
    } catch (error) {
      if (generation === ctx.generation) setMode("offline", error.message);
    }
  }
  async function cloudFetch(method, body = undefined) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8500);
    try {
      const response = await fetch(state.settings.workerUrl.replace(/\/$/, "") +
        "/sync/" + encodeURIComponent(ctx.id), {
        method, signal: controller.signal,
        headers: { "Content-Type": "application/json", "X-App-Password": state.settings.appPassword },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store"
      });
      const data = await response.json().catch(() => ({}));
      if (method === "GET" && response.status === 404) return { revision: 0, missing: true };
      if (!response.ok) {
        const e = new Error(data.error || ("Time sync returned " + response.status));
        e.status = response.status;
        throw e;
      }
      return data;
    } finally {
      clearTimeout(timeout);
    }
  }
  async function encrypt(value) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, ctx.key, bytes));
    return JSON.stringify({ version: 1, iv: encodeBase64Url(iv), data: encodeBase64Url(encrypted) });
  }
  async function decrypt(ciphertext) {
    const envelope = JSON.parse(ciphertext);
    if (envelope.version !== 1) throw new Error("Time record has an unknown format.");
    const bytes = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decodeBase64Url(envelope.iv) },
      ctx.key, decodeBase64Url(envelope.data));
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (value.app !== "RP Studio active time" || value.version !== 1 ||
      typeof value.day !== "string" || !value.usage || typeof value.usage !== "object") {
      throw new Error("Time record could not be verified.");
    }
    for (const amount of Object.values(value.usage)) {
      if (!Number.isFinite(amount) || amount < 0 || amount > 24 * 3600000) {
        throw new Error("Time record has an invalid usage value.");
      }
    }
    return value;
  }
  async function syncOnce() {
    if (ctx.busy || !ctx.id || !ctx.key) return;
    const generation = ctx.generation;
    ctx.busy = true;
    ctx.lastPoll = Date.now();
    try {
      for (let attempt = 0; attempt < 6; attempt++) {
        if (generation !== ctx.generation) return;
        const data = await cloudFetch("GET");
        if (generation !== ctx.generation) return;
        const ledger = data.missing
          ? { app: "RP Studio active time", version: 1, day: ctx.day, usage: {} }
          : await decrypt(data.ciphertext);
        if (generation !== ctx.generation) return;
        if (ledger.day > ctx.day) throw new Error("This device’s date differs from the shared time record.");
        const newDay = ledger.day !== ctx.day;
        const usage = newDay ? {} : { ...ledger.usage };
        const remoteOwn = Number(usage[ctx.device] || 0);
        if (ctx.localMs < remoteOwn) {
          ctx.localMs = remoteOwn;
          saveLocal();
        }
        ctx.othersMs = Object.entries(usage).reduce(
          (sum, [id, value]) => sum + (id === ctx.device ? 0 : value), 0);
        if (total() >= LIMIT) setMode("limit");
        else setMode("ready");
        if (!data.missing && !newDay && ctx.localMs <= remoteOwn) return;
        usage[ctx.device] = Math.ceil(ctx.localMs);
        const ciphertext = await encrypt({
          app: "RP Studio active time", version: 1, day: ctx.day, usage
        });
        try {
          await cloudFetch("PUT", { baseRevision: Number(data.revision || 0), ciphertext });
          if (generation !== ctx.generation) return;
          return;
        } catch (error) {
          if (error.status === 409) continue; // CAS conflict: reread and merge both devices
          throw error;
        }
      }
      throw new Error("Both devices were updating at once. Checking again shortly.");
    } catch (error) {
      if (generation === ctx.generation) setMode("offline", error.name === "AbortError"
        ? "Cloud time verification timed out. RP Studio is paused until it reconnects."
        : error.message);
    } finally {
      ctx.busy = false;
    }
  }

  const canUse = () => ctx.mode === "ready" && remaining() > 0;
  window.RPTimeLimit = { canUse, refreshConnection: initialize };
  // Route every generation path (including Director mode) through the same hard gate.
  if (typeof requestAI === "function") {
    const unguardedRequestAI = requestAI;
    requestAI = async function (...args) {
      if (!canUse()) throw new Error("Daily RP Studio active time is unavailable or exhausted.");
      const result = await unguardedRequestAI(...args);
      if (!canUse()) throw new Error("RP Studio reached its daily active-time limit during the reply.");
      return result;
    };
  }
  document.getElementById("rp-time-retry").onclick = () => { void initialize(); };
  document.getElementById("rp-time-setup").onclick = () => {
    if (typeof loadSettingsForm === "function") loadSettingsForm();
    document.getElementById("settingsDialog").showModal();
  };
  for (const type of ["pointerdown", "touchstart", "keydown", "wheel", "input"]) {
    document.addEventListener(type, event => {
      if (!event.isTrusted || !canUse()) return;
      recordElapsed();
      ctx.lastActivity = Date.now();
    }, { capture: true, passive: true });
  }
  document.addEventListener("visibilitychange", () => {
    recordElapsed();
    ctx.visible = !document.hidden;
    ctx.lastTick = Date.now();
    if (ctx.visible) {
      ctx.lastActivity = Date.now();
      void syncOnce();
    } else {
      void syncOnce(); // best effort on backgrounding; local usage persists independently
    }
  });
  window.addEventListener("pagehide", () => {
    recordElapsed();
    ctx.visible = false;
  });
  setInterval(() => {
    recordElapsed();
    const configured = cloudSync.enabled && cloudSync.code && state.settings.workerUrl && state.settings.appPassword;
    if (!configured && ctx.mode !== "setup") { void initialize(); return; }
    if (configured && ctx.connection !== [cloudSync.code, state.settings.workerUrl, state.settings.appPassword].join("|")) { void initialize(); return; }
    if (configured && !ctx.id && ctx.mode === "setup") { void initialize(); return; }
    if (ctx.id && !ctx.busy && Date.now() - ctx.lastPoll >= POLL) void syncOnce();
  }, 1000);
  void initialize();
})();
