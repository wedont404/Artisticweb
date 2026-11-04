/* DK ARTISTIC HUB - shared core: config, API (plain fetch, no libraries), helpers, theme, map loader */
(function () {
  "use strict";
  var D = (window.DK = window.DK || {});

  /* ================= CONFIG (edit here) ================= */
  D.SUPABASE_URL = "https://qgprmrtyksygfiqpxsxx.supabase.co";
  D.SUPABASE_KEY = "sb_publishable_96xGosb4qjZ0SzGWEgA6MA_CAhDmOa0"; // publishable key: safe in the browser (RLS protects data)
  D.brand = "DK ARTISTIC HUB";
  D.whatsapp = "250782292053";
  D.phoneDisplay = "+250 782 292 053";
  D.ussd = "*182*8*016804#";
  D.area = "Masoro, Kigali";
  D.plusCode = "349W+2C8";
  D.lat = -1.93246; D.lng = 30.14608;           // restaurant position (decoded from the plus code)
  D.openHour = 10; D.closeHour = 23;              // Kigali time
  D.happyFrom = 16; D.happyTo = 19;
  D.credit = "WecodeNo 404-tresor";
  D.currency = "RWF";

  /* ================= tiny helpers ================= */
  var $ = (D.$ = function (s, r) { return (r || document).querySelector(s); });
  D.$$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  D.reduce = !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);
  D.esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
  D.money = function (n) { return Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 0 }) + " " + D.currency; };
  D.store = {
    get: function (k, d) { try { var v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) {} }
  };
  D.uuid = function () {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "k" + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  };
  D.fmtDate = function (iso) {
    if (!iso) return "";
    try { return new Date(iso).toLocaleString("en-GB", { timeZone: "Africa/Kigali", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }); }
    catch (e) { return String(iso); }
  };
  D.kigali = function () {
    var p = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Kigali", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date());
    var h = 0, m = 0;
    p.forEach(function (x) { if (x.type === "hour") h = +x.value % 24; if (x.type === "minute") m = +x.value; });
    return { h: h, m: m, mins: h * 60 + m };
  };
  D.gmaps = function (lat, lng) { return "https://www.google.com/maps?q=" + Number(lat).toFixed(6) + "," + Number(lng).toFixed(6); };
  D.inRwanda = function (lat, lng) { return lat >= -3.0 && lat <= -0.9 && lng >= 28.8 && lng <= 31.0; };

  /* Rwandan phone: same rule as the database. Returns +2507XXXXXXXX or null */
  D.normPhone = function (p) {
    var d = String(p || "").replace(/[^0-9]/g, "");
    if (d.indexOf("250") === 0 && d.length === 12) { /* ok */ }
    else if (d.charAt(0) === "0" && d.length === 10) d = "250" + d.slice(1);
    else if (d.length === 9) d = "250" + d;
    else return null;
    return /^2507[2389][0-9]{7}$/.test(d) ? "+" + d : null;
  };
  D.phoneShow = function (p) { return p ? p.replace(/^\+250(\d{3})(\d{3})(\d{3})$/, "+250 $1 $2 $3") : ""; };

  /* ================= toast / copy / confetti ================= */
  var tt;
  D.toast = function (msg) {
    var el = $("#toast"); if (!el) return;
    el.textContent = msg; el.classList.add("on");
    clearTimeout(tt); tt = setTimeout(function () { el.classList.remove("on"); }, 2600);
  };
  D.copy = function (text) {
    function ok() { D.toast("Copied " + text); }
    function fb() {
      var ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); ok(); } catch (e) { D.toast(text); }
      document.body.removeChild(ta);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(ok, fb); else fb();
  };
  D.confetti = function (count) {
    if (D.reduce) return;
    var cv = $("#confetti"); if (!cv) return;
    var cx = cv.getContext("2d"); cv.width = innerWidth; cv.height = innerHeight;
    var cols = ["#f7b7e3", "#ff8fd0", "#ffd27a", "#8ff0c4", "#ffffff"], ps = [], N = count || 140, i;
    for (i = 0; i < N; i++) ps.push({ x: innerWidth / 2, y: innerHeight * 0.55, vx: (Math.random() - .5) * 16, vy: -Math.random() * 15 - 4, s: Math.random() * 8 + 4, c: cols[i % cols.length], r: Math.random() * 6, vr: (Math.random() - .5) * .4 });
    var f = 0;
    (function step() {
      cx.clearRect(0, 0, cv.width, cv.height);
      ps.forEach(function (p) { p.vy += .35; p.x += p.vx; p.y += p.vy; p.r += p.vr; cx.save(); cx.translate(p.x, p.y); cx.rotate(p.r); cx.fillStyle = p.c; cx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * .6); cx.restore(); });
      if (++f < 130) requestAnimationFrame(step); else cx.clearRect(0, 0, cv.width, cv.height);
    })();
  };

  /* ================= friendly errors ================= */
  var MSG = {
    network: "No connection. Check your internet and try again.",
    invalid_phone: "Enter a valid Rwandan phone number, e.g. 0788 123 456.",
    invalid_name: "Please enter your full name.",
    invalid_fulfillment_type: "Please choose delivery, pickup or dine-in.",
    delivery_address_required: "Please enter your delivery address.",
    delivery_location_required: "Please confirm your exact location on the map.",
    delivery_location_outside_rwanda: "That location is outside Rwanda.",
    invalid_items: "Your cart looks invalid. Please refresh the page.",
    invalid_quantity: "Quantity must be between 1 and 99.",
    item_unavailable: "Sorry, an item in your cart just became unavailable.",
    invalid_payment_method: "Please choose a payment method.",
    rate_limited: "Too many attempts. Please wait a few minutes and try again.",
    idempotency_conflict: "This checkout was already used. Please refresh and try again.",
    instructions_too_long: "Delivery notes are too long (max 500 characters).",
    order_cancelled: "This order was cancelled.",
    invalid_reference: "The reference must be 4-64 letters or numbers (no spaces).",
    reference_already_used: "That payment reference was already used.",
    reference_not_required: "This payment method does not need a reference.",
    already_paid: "This order is already paid.",
    order_refunded: "This order was refunded.",
    forbidden: "You are not allowed to do that.",
    invalid_transition: "That status change is not allowed from the current status.",
    cancel_reason_required: "Please write a reason for cancelling.",
    delivery_must_go_out_first: "A delivery order must be marked Out for delivery before Delivered.",
    not_a_delivery_order: "This is not a delivery order.",
    location_incomplete: "Set both latitude and longitude, or neither.",
    location_outside_rwanda: "That location is outside Rwanda.",
    not_in_progress: "You can only post progress while the order is being prepared or delivered.",
    nothing_to_update: "Add a note, an ETA or a position first.",
    invalid_fee: "Enter a delivery fee between 0 and 1,000,000.",
    order_closed: "This order is already closed.",
    locked_after_payment: "The fee cannot change after the order is paid.",
    invalid_payment_transition: "That payment change is not allowed from the current payment status.",
    notes_required: "Please write a short note (at least 3 characters).",
    amount_too_low: "The amount received is less than the amount due.",
    note_too_long: "That note is too long.",
    order_not_found: "Order not found.",
    payment_not_found: "Payment not found.",
    "42501": "You are not allowed to do that."
  };
  D.friendly = function (e) {
    if (!e) return "Something went wrong.";
    var c = e.code || e.message;
    if (c && MSG[c]) return MSG[c];
    if (e.status === 401 || e.status === 403) return "Your session expired or you do not have access. Please sign in again.";
    if (e.status === 404 || (e.message && /relation|schema cache|function/i.test(e.message))) return "The database is not installed yet. Run all_in_one.sql in Supabase first.";
    return (e.message && e.message.length < 140 ? e.message : "Something went wrong. Please try again.");
  };

  /* ================= API (PostgREST + GoTrue + Storage over plain fetch) ================= */
  D.api = {
    tokenFn: null, // admin page sets this
    headers: async function (extra) {
      var h = { apikey: D.SUPABASE_KEY, "Content-Type": "application/json" };
      if (D.api.tokenFn) { var t = await D.api.tokenFn(); if (t) h.Authorization = "Bearer " + t; }
      if (extra) for (var k in extra) h[k] = extra[k];
      return h;
    },
    req: async function (method, path, body, extra, raw) {
      var res, h = await D.api.headers(extra);
      try {
        res = await fetch(D.SUPABASE_URL + path, { method: method, headers: h, body: body == null ? undefined : (raw ? body : JSON.stringify(body)) });
      } catch (e) { var ne = new Error("network"); ne.code = "network"; throw ne; }
      var txt = await res.text(), data = null;
      try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = txt; }
      if (!res.ok) {
        var b = data && typeof data === "object" ? data : {};
        var er = new Error(b.message || b.msg || b.error_description || b.error || res.statusText || "error");
        // RAISE EXCEPTION 'xyz' in SQL arrives as code P0001 with message "xyz": use the message as our code.
        er.code = b.code === "P0001" ? b.message : String(b.code || b.error_code || res.status);
        er.status = res.status; er.details = b.details;
        throw er;
      }
      return data;
    },
    get: function (path) { return D.api.req("GET", "/rest/v1/" + path); },
    rpc: function (name, args) { return D.api.req("POST", "/rest/v1/rpc/" + name, args || {}); },
    insert: function (table, row) { return D.api.req("POST", "/rest/v1/" + table, row, { Prefer: "return=representation" }); },
    update: function (table, filter, patch) { return D.api.req("PATCH", "/rest/v1/" + table + "?" + filter, patch, { Prefer: "return=representation" }); },
    remove: function (table, filter) { return D.api.req("DELETE", "/rest/v1/" + table + "?" + filter, null, { Prefer: "return=representation" }); }
  };

  /* ================= theme / vibe / size ================= */
  var VIBES = ["plum", "sunset", "neon"];
  D.applyTheme = function () {
    var th = D.store.get("dk_theme", "dark"), vb = D.store.get("dk_vibe", "plum"), r = document.documentElement;
    r.setAttribute("data-theme", th); r.setAttribute("data-vibe", vb);
    r.classList.toggle("big", D.store.get("dk_big", "0") === "1");
    var b = $("#themeBtn"); if (b) b.textContent = th === "dark" ? "\u{1F319}" : "☀️";
    var mc = document.querySelector('meta[name="theme-color"]'); if (mc) mc.setAttribute("content", th === "dark" ? "#4d3844" : "#fff6fb");
  };
  function bindTheme() {
    var t = $("#themeBtn"), v = $("#vibeBtn"), s = $("#sizeBtn");
    if (t) t.addEventListener("click", function () { D.store.set("dk_theme", D.store.get("dk_theme", "dark") === "dark" ? "light" : "dark"); D.applyTheme(); });
    if (v) v.addEventListener("click", function () { var n = VIBES[(VIBES.indexOf(D.store.get("dk_vibe", "plum")) + 1) % VIBES.length]; D.store.set("dk_vibe", n); D.applyTheme(); D.toast("Vibe: " + n); });
    if (s) s.addEventListener("click", function () { D.store.set("dk_big", D.store.get("dk_big", "0") === "1" ? "0" : "1"); D.applyTheme(); });
  }

  /* ================= maps (Leaflet + OpenStreetMap: free, no API key) ================= */
  var leafletP = null;
  D.loadMap = function () {
    if (window.L) return Promise.resolve(window.L);
    if (leafletP) return leafletP;
    leafletP = new Promise(function (ok, bad) {
      var css = document.createElement("link"); css.rel = "stylesheet";
      css.href = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css"; document.head.appendChild(css);
      var js = document.createElement("script");
      js.src = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js";
      js.onload = function () { ok(window.L); };
      js.onerror = function () { leafletP = null; bad(new Error("Map failed to load")); };
      document.head.appendChild(js);
    });
    return leafletP;
  };
  D.makeMap = function (el, lat, lng, zoom) {
    var m = window.L.map(el, { scrollWheelZoom: false, zoomControl: true, attributionControl: true }).setView([lat, lng], zoom || 15);
    window.L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap" }).addTo(m);
    return m;
  };
  D.pin = function (emoji, cls) {
    return window.L.divIcon({ className: "pin " + (cls || ""), html: "<span><em>" + emoji + "</em></span>", iconSize: [38, 38], iconAnchor: [19, 36] });
  };

  /* ================= start ================= */
  D.applyTheme();
  document.addEventListener("DOMContentLoaded", function () {
    bindTheme();
    var y = $("#year"); if (y) y.textContent = new Date().getFullYear();
    var c = $("#creditName"); if (c) c.textContent = D.credit;
    if ("serviceWorker" in navigator && location.protocol.indexOf("http") === 0) navigator.serviceWorker.register("sw.js").catch(function () {});
  });
})();
