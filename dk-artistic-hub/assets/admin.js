/* DK ARTISTIC HUB - admin dashboard (administrators only; every action is re-checked by the database) */
(function () {
  "use strict";
  var D = window.DK, $ = D.$, $$ = D.$$, esc = D.esc, money = D.money;
  var SES = null, refreshing = null, poll = null, lastPending = null, methods = [], admins = {};
  var OS = ["pending", "confirmed", "preparing", "ready", "out_for_delivery", "delivered", "cancelled"];
  var PS = ["unpaid", "pending_verification", "paid", "failed", "refunded"];
  var LABEL = { pending: "Pending", confirmed: "Confirmed", preparing: "Preparing", ready: "Ready", out_for_delivery: "Out for delivery", delivered: "Delivered", cancelled: "Cancelled",
    unpaid: "Unpaid", pending_verification: "To verify", paid: "Paid", failed: "Failed", refunded: "Refunded" };
  var NEXT = { pending: ["confirmed", "cancelled"], confirmed: ["preparing", "cancelled"], preparing: ["ready", "cancelled"], ready: ["out_for_delivery", "delivered", "cancelled"], out_for_delivery: ["delivered", "cancelled"] };
  var ACT = { confirmed: "Confirm order", preparing: "Start preparing", ready: "Mark ready", out_for_delivery: "Send out for delivery", delivered: "Mark delivered", cancelled: "Cancel order" };

  function fe(e) {
    var m = { "23505": "That already exists.", "23514": "A value is not allowed. Check name, price and image link.", "23503": "Move or delete the related items first." };
    return (e && m[e.code]) || D.friendly(e);
  }
  function chip(v) { return '<span class="chip c-' + esc(v) + '">' + esc(LABEL[v] || v) + "</span>"; }

  /* ================= auth (GoTrue over fetch) ================= */
  async function auth(path, method, body, bearer) {
    var h = { apikey: D.SUPABASE_KEY, "Content-Type": "application/json" }; if (bearer) h.Authorization = "Bearer " + bearer;
    var res; try { res = await fetch(D.SUPABASE_URL + path, { method: method, headers: h, body: body ? JSON.stringify(body) : undefined }); } catch (e) { var n = new Error("network"); n.code = "network"; throw n; }
    var t = await res.text(), j = null; try { j = t ? JSON.parse(t) : null; } catch (e) {}
    if (!res.ok) { var er = new Error((j && (j.msg || j.error_description || j.message || j.error)) || "Sign in failed"); er.status = res.status; er.code = (j && (j.error_code || j.error)) || String(res.status); throw er; }
    return j;
  }
  function toSes(r) { return { access_token: r.access_token, refresh_token: r.refresh_token, expires_at: r.expires_at || Math.floor(Date.now() / 1000) + (+r.expires_in || 3600) }; }
  function saveSes(s) { SES = s; if (s) D.store.set("dk_admin_ses", JSON.stringify(s)); else D.store.del("dk_admin_ses"); }
  async function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async function () {
      try { saveSes(toSes(await auth("/auth/v1/token?grant_type=refresh_token", "POST", { refresh_token: SES.refresh_token }))); }
      catch (e) { saveSes(null); }
      finally { refreshing = null; }
    })();
    return refreshing;
  }
  D.api.tokenFn = async function () {
    if (!SES) return null;
    if (SES.expires_at * 1000 - Date.now() < 60000) await refresh();
    return SES ? SES.access_token : null;
  };
  function show(view) { ["viewLogin", "viewSetPw", "viewApp"].forEach(function (id) { $("#" + id).hidden = id !== view; }); $("#logoutBtn").hidden = view === "viewLogin"; if (view === "viewLogin") $("#whoami").hidden = true; }
  async function enter() {
    var ok = await D.api.rpc("claim_admin");
    if (ok !== true) { await logout(); var e = new Error("This account is not an authorized administrator."); e.code = "notadmin"; throw e; }
    show("viewApp"); startApp();
  }
  async function logout(silent) {
    var t = SES && SES.access_token; saveSes(null); clearInterval(poll); poll = null;
    if (t) { try { await auth("/auth/v1/logout", "POST", null, t); } catch (e) {} }
    show("viewLogin"); closeDrawer(); if (!silent) $("#lErr").textContent = "";
  }
  async function guard(fn) { // run an admin action; on 401 go back to login
    try { return await fn(); } catch (e) { if (e.status === 401) { await logout(); $("#lErr").textContent = "Your session expired. Please sign in again."; } throw e; }
  }

  /* ================= app shell ================= */
  var O = { search: "", os: "", ps: "", from: "", to: "", offset: 0, limit: 25, total: 0 };
  async function startApp() {
    try { var me = await D.api.get("admin_users?select=id,email,role&order=email.asc"); admins = {}; me.forEach(function (a) { admins[a.id] = a.email; }); $("#whoami").hidden = false; $("#whoami").textContent = me.length ? "Admins: " + me.length : ""; } catch (e) {}
    try { methods = await D.api.get("payment_methods?select=*&order=sort_order.asc"); } catch (e) {}
    fillFilters(); tab("orders"); clearInterval(poll); poll = setInterval(tick, 30000);
  }
  function fillFilters() {
    $("#fOs").innerHTML = '<option value="">All</option>' + OS.map(function (s) { return '<option value="' + s + '">' + LABEL[s] + "</option>"; }).join("");
    $("#fPs").innerHTML = '<option value="">All</option>' + PS.map(function (s) { return '<option value="' + s + '">' + LABEL[s] + "</option>"; }).join("");
  }
  function tab(name) {
    $$("#tabs button").forEach(function (b) { b.classList.toggle("on", b.getAttribute("data-tab") === name); });
    $("#tabOrders").hidden = name !== "orders"; $("#tabProducts").hidden = name !== "products"; $("#tabPayments").hidden = name !== "payments";
    if (name === "orders") { loadStats(); loadOrders(); } else if (name === "products") loadProducts(); else renderMethods();
  }
  function tick() {
    if (document.hidden || !SES || $("#drawer").classList.contains("on")) return;
    if (!$("#tabOrders").hidden) { loadStats(true); loadOrders(true); }
  }
  function beep() { try { var c = new (window.AudioContext || window.webkitAudioContext)(), o = c.createOscillator(), g = c.createGain(); o.connect(g); g.connect(c.destination); o.frequency.value = 880; g.gain.value = .08; o.start(); setTimeout(function () { o.stop(); c.close(); }, 220); } catch (e) {} }

  /* ================= dashboard stats ================= */
  var CARDS = [["pending", "Pending", { os: "pending" }], ["confirmed", "Confirmed", { os: "confirmed" }], ["preparing", "Preparing", { os: "preparing" }], ["ready", "Ready", { os: "ready" }],
    ["out_for_delivery", "Out for delivery", { os: "out_for_delivery" }], ["delivered", "Delivered", { os: "delivered" }], ["unpaid", "Unpaid", { ps: "unpaid" }],
    ["pending_verification", "To verify", { ps: "pending_verification" }], ["paid_orders", "Paid", { ps: "paid" }], ["total_orders", "All orders", {}], ["revenue_paid", "Revenue (paid)", null]];
  async function loadStats(quiet) {
    try {
      var s = await guard(function () { return D.api.rpc("admin_dashboard_stats"); });
      $("#stats").innerHTML = CARDS.map(function (c, i) {
        var v = c[0] === "revenue_paid" ? money(s[c[0]]) : s[c[0]];
        return '<button class="stat" data-card="' + i + '"' + (c[2] ? "" : " disabled") + "><b>" + esc(v) + "</b><span>" + c[1] + "</span></button>";
      }).join("");
      if (lastPending !== null && s.pending > lastPending && quiet) { D.toast("New order received!"); beep(); }
      lastPending = s.pending; document.title = (s.pending > 0 ? "(" + s.pending + ") " : "") + "Admin - DK ARTISTIC HUB";
    } catch (e) { if (!quiet) D.toast(fe(e)); }
  }
  async function loadOrders(quiet) {
    try {
      var r = await guard(function () {
        return D.api.rpc("admin_list_orders", { p_search: O.search || null, p_order_status: O.os || null, p_payment_status: O.ps || null, p_from: O.from || null, p_to: O.to || null, p_limit: O.limit, p_offset: O.offset });
      });
      O.total = +r.total;
      $("#orows").innerHTML = r.rows.length ? r.rows.map(function (o) {
        return '<button class="orow" data-open="' + esc(o.id) + '"><b>' + esc(o.order_number) + '</b><span class="muted small">' + esc(D.fmtDate(o.created_at)) + "</span><span>" + chip(o.order_status) + "</span>" +
          "<span>" + esc(o.customer_name) + '<br><span class="muted small">' + esc(D.phoneShow(o.customer_phone)) + "</span></span><b>" + money(o.total_amount) + "</b><span>" + chip(o.payment_status) + "</span></button>";
      }).join("") : '<div class="empty card">No orders match.</div>';
      var from = O.total ? O.offset + 1 : 0, to = Math.min(O.offset + O.limit, O.total);
      $("#pageInfo").textContent = from + "-" + to + " of " + O.total;
      $("#prevP").disabled = O.offset <= 0; $("#nextP").disabled = O.offset + O.limit >= O.total;
    } catch (e) { if (!quiet) D.toast(fe(e)); }
  }
  function readFilters() { O.search = $("#fSearch").value.trim(); O.os = $("#fOs").value; O.ps = $("#fPs").value; O.from = $("#fFrom").value; O.to = $("#fTo").value; O.offset = 0; }
  function applyCard(i) {
    var f = CARDS[i][2]; if (!f) return;
    $("#fSearch").value = ""; $("#fFrom").value = ""; $("#fTo").value = ""; $("#fOs").value = f.os || ""; $("#fPs").value = f.ps || ""; readFilters(); loadOrders();
  }

  /* ================= order detail drawer ================= */
  var cur = null, cmap = null, cpin = null, CP = null;
  function closeDrawer() { $("#drawer").classList.remove("on"); $("#overlay").classList.remove("on"); $("#drawer").setAttribute("aria-hidden", "true"); document.body.style.overflow = ""; if (cmap) { cmap.remove(); cmap = null; cpin = null; } cur = null; }
  async function openOrder(id, keepScroll) {
    var d = $("#drawer"), body = $("#dBody"), sc = keepScroll ? body.scrollTop : 0;
    d.classList.add("on"); $("#overlay").classList.add("on"); d.setAttribute("aria-hidden", "false"); document.body.style.overflow = "hidden";
    if (!keepScroll) body.innerHTML = '<div class="skel"></div>';
    try {
      var r = await guard(function () {
        return Promise.all([
          D.api.get("orders?id=eq." + encodeURIComponent(id) + "&select=*"),
          D.api.get("order_items?order_id=eq." + encodeURIComponent(id) + "&select=*&order=created_at.asc"),
          D.api.get("payments?order_id=eq." + encodeURIComponent(id) + "&select=*&order=created_at.desc"),
          D.api.get("order_status_history?order_id=eq." + encodeURIComponent(id) + "&select=*&order=created_at.desc")
        ]);
      });
      if (!r[0].length) { body.innerHTML = '<p class="err">Order not found.</p>'; return; }
      cur = { o: r[0][0], items: r[1], pays: r[2], hist: r[3] }; CP = null;
      renderOrder(); body.scrollTop = sc;
    } catch (e) { body.innerHTML = '<p class="err">' + esc(fe(e)) + "</p>"; }
  }
  function methodName(code) { for (var i = 0; i < methods.length; i++) if (methods[i].code === code) return methods[i].name; return code; }
  function renderOrder() {
    var o = cur.o, isDel = o.fulfillment_type === "delivery", closed = o.order_status === "delivered" || o.order_status === "cancelled";
    $("#dTitle").textContent = o.order_number;
    var paid = cur.pays.some(function (p) { return p.payment_status === "paid"; });
    var h = '<div class="row" style="justify-content:space-between;align-items:center"><div>' + chip(o.order_status) + " " + chip(o.payment_status) + '</div><span class="muted small">' + esc(D.fmtDate(o.created_at)) + "</span></div>";

    h += '<div class="sec-box"><h4>Customer</h4><dl class="kv"><dt>Name</dt><dd>' + esc(o.customer_name) + "</dd><dt>Phone</dt><dd>" + esc(D.phoneShow(o.customer_phone)) +
      ' &middot; <a class="chip" href="tel:' + esc(o.customer_phone) + '">Call</a> <a class="chip" target="_blank" rel="noopener" href="https://wa.me/' + esc(o.customer_phone.replace("+", "")) + "?text=" + encodeURIComponent("Hello " + o.customer_name + ", about your order " + o.order_number) + '">WhatsApp</a></dd>' +
      "<dt>Type</dt><dd>" + esc(o.fulfillment_type.replace("_", "-")) + "</dd>" +
      (isDel ? "<dt>Address</dt><dd>" + esc(o.delivery_address) + '</dd><dt>Exact spot</dt><dd><a class="chip" target="_blank" rel="noopener" href="' + D.gmaps(o.delivery_latitude, o.delivery_longitude) + '">Open in Google Maps</a> <span class="muted small">' + (+o.delivery_latitude).toFixed(5) + ", " + (+o.delivery_longitude).toFixed(5) + "</span></dd>" : "") +
      (o.delivery_instructions ? "<dt>Landmark</dt><dd>" + esc(o.delivery_instructions) + "</dd>" : "") + "</dl>" +
      (isDel ? '<div class="mapbox" id="oMap"></div>' : "") + "</div>";

    h += '<div class="sec-box"><h4>Items</h4><table class="tbl"><tr><th>Item</th><th class="r">Qty</th><th class="r">Unit</th><th class="r">Total</th></tr>' +
      cur.items.map(function (i) { return "<tr><td>" + esc(i.product_name_snapshot) + '</td><td class="r">' + i.quantity + '</td><td class="r">' + money(i.unit_price) + '</td><td class="r">' + money(i.total_price) + "</td></tr>"; }).join("") + "</table>" +
      '<dl class="kv" style="margin-top:10px"><dt>Subtotal</dt><dd>' + money(o.subtotal) + "</dd><dt>Delivery fee</dt><dd>" + money(o.delivery_fee) + "</dd><dt>Total</dt><dd><b>" + money(o.total_amount) + "</b></dd></dl>";
    if (isDel && !closed) {
      h += '<div class="grid2" style="margin-top:10px;align-items:end"><div><label for="fee" style="margin:0 0 4px">Delivery fee (RWF)</label><input id="fee" type="number" min="0" step="100" value="' + esc(Math.round(o.delivery_fee)) + '"' + (paid ? " disabled" : "") + '></div><button class="btn ghost" id="saveFee"' + (paid ? " disabled" : "") + ">Save fee</button></div>" + (paid ? '<p class="muted small">The fee is locked after payment.</p>' : "");
    }
    h += "</div>";

    // status actions
    var nexts = (NEXT[o.order_status] || []).filter(function (s) { return !(s === "out_for_delivery" && !isDel) && !(s === "delivered" && o.order_status === "ready" && isDel); });
    var progressOk = ["confirmed", "preparing", "ready", "out_for_delivery"].indexOf(o.order_status) > -1;
    h += '<div class="sec-box"><h4>Order status</h4>';
    if (!nexts.length && !progressOk) h += '<p class="muted">This order is closed.</p>';
    else {
      h += '<label for="aNote" style="margin-top:0">Note for the customer (shown on tracking)</label><input id="aNote" maxlength="500" placeholder="e.g. On the grill, rider leaving in 10 min">';
      h += '<label for="aEta">Estimated delivery / ready time (optional)</label><input id="aEta" type="datetime-local">';
      if (isDel && ["ready", "out_for_delivery"].indexOf(o.order_status) > -1) {
        h += '<label>Rider position (optional, shown to the customer)</label><div class="row"><button class="btn ghost sm" id="myPos" type="button">Use my location</button><button class="btn ghost sm" id="clrPos" type="button">Clear</button><span class="small muted" id="cpTxt">Not set. Tap the map to place the rider.</span></div><div class="mapbox" id="cMap" style="height:200px"></div>';
      }
      h += '<div class="row" style="margin-top:12px">' + nexts.map(function (s) { return '<button class="btn ' + (s === "cancelled" ? "danger" : "primary") + ' sm" data-status="' + s + '">' + ACT[s] + "</button>"; }).join("") +
        (progressOk ? '<button class="btn ghost sm" id="postProg">Post progress update</button>' : "") + "</div>";
      h += '<p class="small muted" style="margin-top:8px">Cancelling needs a reason in the note box.</p>';
    }
    h += '<p class="err" id="aErr" role="alert"></p></div>';

    // payments
    h += '<div class="sec-box"><h4>Payment</h4>' + (cur.pays.length ? cur.pays.map(payHTML).join("") : '<p class="muted">No payment record.</p>') + "</div>";

    h += '<div class="sec-box"><h4>Internal notes (staff only)</h4><textarea id="iNotes" rows="3" maxlength="2000" placeholder="Only staff can see this">' + esc(o.internal_notes || "") + '</textarea><button class="btn ghost sm" id="saveNotes" style="margin-top:8px">Save notes</button></div>';

    h += '<div class="sec-box"><h4>History</h4><ul class="tl">' + cur.hist.map(function (x) {
      return "<li><b>" + esc(LABEL[x.new_status] || x.new_status) + '</b> <span class="muted small">' + esc(D.fmtDate(x.created_at)) + (x.updated_by && admins[x.updated_by] ? " &middot; " + esc(admins[x.updated_by]) : "") + "</span>" +
        (x.progress_note ? "<br>" + esc(x.progress_note) : "") + (x.location_latitude != null ? '<br><a class="small" target="_blank" rel="noopener" href="' + D.gmaps(x.location_latitude, x.location_longitude) + '">Rider position</a>' : "") +
        (x.estimated_delivery_at ? '<br><span class="small muted">ETA ' + esc(D.fmtDate(x.estimated_delivery_at)) + "</span>" : "") + "</li>";
    }).join("") + "</ul></div>";

    $("#dBody").innerHTML = h;
    if (isDel) drawOrderMap();
    if ($("#cMap")) drawCourierMap();
  }
  function payHTML(p) {
    var canPay = p.payment_status === "unpaid" || p.payment_status === "pending_verification" || p.payment_status === "failed";
    var s = '<div class="box" style="margin-bottom:10px"><div class="row" style="justify-content:space-between"><b>' + esc(methodName(p.payment_method)) + "</b>" + chip(p.payment_status) + "</div>" +
      '<dl class="kv" style="margin-top:6px"><dt>Amount due</dt><dd>' + money(p.amount) + "</dd>" + (p.payment_reference ? "<dt>Customer's reference</dt><dd>" + esc(p.payment_reference) + "</dd>" : "") +
      (p.verified_at ? "<dt>Checked</dt><dd>" + esc(D.fmtDate(p.verified_at)) + (p.verified_by && admins[p.verified_by] ? " by " + esc(admins[p.verified_by]) : "") + "</dd>" : "") + (p.verification_notes ? "<dt>Note</dt><dd>" + esc(p.verification_notes) + "</dd>" : "") + "</dl>";
    if (canPay || p.payment_status === "paid") {
      s += '<input data-pnote="' + esc(p.id) + '" maxlength="500" placeholder="Note (required for failed / refund)" style="margin-top:8px">';
      if (canPay) s += '<input data-pamt="' + esc(p.id) + '" type="number" min="0" placeholder="Amount received (optional, default ' + Math.round(p.amount) + ')" style="margin-top:8px">';
      s += '<div class="row" style="margin-top:8px">';
      if (canPay) s += '<button class="btn primary sm" data-pay="' + esc(p.id) + '" data-to="paid">Mark paid</button>' + (p.payment_status !== "failed" ? '<button class="btn danger sm" data-pay="' + esc(p.id) + '" data-to="failed">Mark failed</button>' : "");
      if (p.payment_status === "paid") s += '<button class="btn danger sm" data-pay="' + esc(p.id) + '" data-to="refunded">Refund</button>';
      s += "</div>";
    }
    return s + "</div>";
  }
  var omap = null;
  function drawOrderMap() {
    var o = cur.o; if (o.delivery_latitude == null) return;
    D.loadMap().then(function (L) {
      var el = $("#oMap"); if (!el) return; if (omap) { omap.remove(); omap = null; }
      omap = D.makeMap(el, +o.delivery_latitude, +o.delivery_longitude, 16);
      L.marker([+o.delivery_latitude, +o.delivery_longitude], { icon: D.pin("\u{1F3E0}") }).addTo(omap).bindPopup(esc(o.delivery_address));
      setTimeout(function () { omap && omap.invalidateSize(); }, 400);
    }).catch(function () { var el = $("#oMap"); if (el) el.outerHTML = '<p class="muted small">Map unavailable. Use the Google Maps link.</p>'; });
  }
  function setCP(lat, lng) {
    CP = lat == null ? null : { lat: lat, lng: lng };
    $("#cpTxt").textContent = CP ? "Rider at " + lat.toFixed(5) + ", " + lng.toFixed(5) : "Not set. Tap the map to place the rider.";
    if (cmap) { if (cpin) { cmap.removeLayer(cpin); cpin = null; } if (CP) { cpin = window.L.marker([lat, lng], { icon: D.pin("\u{1F6F5}") }).addTo(cmap); cmap.setView([lat, lng], Math.max(cmap.getZoom(), 15)); } }
  }
  function drawCourierMap() {
    D.loadMap().then(function (L) {
      var el = $("#cMap"); if (!el) return; if (cmap) { cmap.remove(); cmap = null; }
      cmap = D.makeMap(el, +cur.o.delivery_latitude || D.lat, +cur.o.delivery_longitude || D.lng, 14);
      L.marker([+cur.o.delivery_latitude, +cur.o.delivery_longitude], { icon: D.pin("\u{1F3E0}") }).addTo(cmap);
      cmap.on("click", function (e) { setCP(e.latlng.lat, e.latlng.lng); });
      setTimeout(function () { cmap && cmap.invalidateSize(); }, 400);
    }).catch(function () {});
  }
  function myPos() {
    if (!navigator.geolocation) { D.toast("Location not supported"); return; }
    navigator.geolocation.getCurrentPosition(function (p) { setCP(p.coords.latitude, p.coords.longitude); }, function () { D.toast("Could not get your location"); }, { enableHighAccuracy: true, timeout: 12000 });
  }
  function etaVal() { var v = $("#aEta") && $("#aEta").value; if (!v) return null; var d = new Date(v); return isNaN(d) ? null : d.toISOString(); }
  async function run(btn, fn, okMsg) {
    var err = $("#aErr"); if (err) err.textContent = ""; if (btn) btn.disabled = true;
    try { await guard(fn); if (okMsg) D.toast(okMsg); await openOrder(cur.o.id, true); loadStats(true); loadOrders(true); }
    catch (e) { if (err) err.textContent = fe(e); else D.toast(fe(e)); if (btn) btn.disabled = false; }
  }
  function drawerClick(e) {
    var b = e.target.closest("button"); if (!b || !cur) return; var o = cur.o;
    if (b.hasAttribute("data-status")) {
      var to = b.getAttribute("data-status"), note = $("#aNote").value.trim();
      if (to === "cancelled" && note.length < 2) { $("#aErr").textContent = D.friendly({ code: "cancel_reason_required" }); $("#aNote").focus(); return; }
      if (to === "cancelled" && !confirm("Cancel order " + o.order_number + "?")) return;
      run(b, function () { return D.api.rpc("admin_set_order_status", { p_order_id: o.id, p_new_status: to, p_note: note || null, p_lat: CP ? CP.lat : null, p_lng: CP ? CP.lng : null, p_eta: etaVal() }); }, ACT[to] + " done");
    } else if (b.id === "postProg") {
      run(b, function () { return D.api.rpc("admin_add_progress", { p_order_id: o.id, p_note: $("#aNote").value.trim() || null, p_lat: CP ? CP.lat : null, p_lng: CP ? CP.lng : null, p_eta: etaVal() }); }, "Progress posted");
    } else if (b.id === "saveFee") {
      var fee = Number($("#fee").value); run(b, function () { return D.api.rpc("admin_set_delivery_fee", { p_order_id: o.id, p_fee: fee }); }, "Delivery fee saved");
    } else if (b.hasAttribute("data-pay")) {
      var pid = b.getAttribute("data-pay"), st = b.getAttribute("data-to"), nEl = $('[data-pnote="' + pid + '"]'), aEl = $('[data-pamt="' + pid + '"]');
      var note2 = nEl ? nEl.value.trim() : "", amt = aEl && aEl.value !== "" ? Number(aEl.value) : null;
      if (st !== "paid" && !confirm((st === "refunded" ? "Refund" : "Mark as failed") + " this payment?")) return;
      run(b, function () { return D.api.rpc("admin_verify_payment", { p_payment_id: pid, p_status: st, p_notes: note2 || null, p_amount_received: amt }); }, "Payment marked " + (LABEL[st] || st).toLowerCase());
    } else if (b.id === "saveNotes") {
      run(b, function () { return D.api.rpc("admin_set_internal_notes", { p_order_id: o.id, p_notes: $("#iNotes").value }); }, "Notes saved");
    } else if (b.id === "myPos") myPos(); else if (b.id === "clrPos") setCP(null);
  }

  /* ================= products ================= */
  var PD = { cats: [], prods: [] };
  async function loadProducts() {
    var box = $("#tabProducts"); box.innerHTML = '<div class="skel"></div>';
    try {
      var r = await guard(function () { return Promise.all([D.api.get("categories?select=*&order=sort_order.asc"), D.api.get("products?select=*&order=sort_order.asc")]); });
      PD.cats = r[0]; PD.prods = r[1]; renderProducts();
    } catch (e) { box.innerHTML = '<p class="err">' + esc(fe(e)) + "</p>"; }
  }
  function renderProducts() {
    var h = '<div class="row" style="justify-content:space-between;align-items:center;margin-bottom:10px"><h3 style="margin:0">Categories</h3><button class="btn primary sm" data-catedit="">+ Category</button></div><div class="row">' +
      PD.cats.map(function (c) { return '<button class="chip ' + (c.is_active ? "c-ready" : "c-cancelled") + '" data-catedit="' + esc(c.id) + '">' + esc((c.emoji || "") + " " + c.name) + (c.is_active ? "" : " (hidden)") + "</button>"; }).join("") + "</div>";
    h += '<div class="row" style="justify-content:space-between;align-items:center;margin:20px 0 10px"><h3 style="margin:0">Products</h3><button class="btn primary sm" data-pedit="">+ Product</button></div><div class="plist">';
    PD.cats.forEach(function (c) {
      var list = PD.prods.filter(function (p) { return p.category_id === c.id; });
      if (!list.length) return;
      h += '<h4 style="margin-top:10px">' + esc((c.emoji || "") + " " + c.name) + "</h4>";
      h += list.map(function (p) {
        return '<div class="prow"><div class="th">' + (p.image_url ? '<img src="' + esc(p.image_url) + '" alt="">' : esc(p.emoji || "\u{1F37D}️")) + "</div><div><b>" + esc(p.name) + "</b> " + (p.tag ? '<span class="chip c-pending">' + esc(p.tag) + "</span>" : "") +
          '<br><span class="price">' + money(p.price) + '</span></div><div class="acts"><label class="inline" style="margin:0"><input type="checkbox" data-tog="is_active" data-id="' + esc(p.id) + '"' + (p.is_active ? " checked" : "") + '> Visible</label><label class="inline" style="margin:0"><input type="checkbox" data-tog="is_available" data-id="' + esc(p.id) + '"' + (p.is_available ? " checked" : "") + '> In stock</label>' +
          '<button class="btn ghost sm" data-pedit="' + esc(p.id) + '">Edit</button><button class="btn danger sm" data-pdel="' + esc(p.id) + '">Delete</button></div></div>';
      }).join("");
    });
    if (!PD.prods.length) h += '<div class="empty card">No products yet. Add your first one.</div>';
    $("#tabProducts").innerHTML = h + "</div>";
  }
  function modal(html, mount) {
    var m = document.createElement("div"); m.className = "modal"; m.innerHTML = '<div class="card">' + html + "</div>"; document.body.appendChild(m);
    function close() { m.remove(); document.removeEventListener("keydown", esc2); }
    function esc2(e) { if (e.key === "Escape") close(); }
    m.addEventListener("click", function (e) { if (e.target === m || e.target.closest("[data-close]")) close(); });
    document.addEventListener("keydown", esc2); mount(m, close); return m;
  }
  function catForm(id) {
    var c = PD.cats.filter(function (x) { return x.id === id; })[0] || {};
    modal("<h3>" + (id ? "Edit category" : "New category") + '</h3><form id="cf" novalidate><label>Name</label><input name="name" maxlength="60" value="' + esc(c.name || "") + '"><div class="grid2"><div><label>Emoji</label><input name="emoji" maxlength="8" value="' + esc(c.emoji || "") + '"></div><div><label>Order</label><input name="sort_order" type="number" value="' + esc(c.sort_order != null ? c.sort_order : PD.cats.length + 1) + '"></div></div>' +
      '<label class="inline"><input type="checkbox" name="is_active"' + (c.is_active === false ? "" : " checked") + '> Visible on the menu</label><p class="err" data-err></p><div class="row"><button class="btn primary" type="submit">Save</button>' + (id ? '<button class="btn danger" type="button" data-del>Delete</button>' : "") + '<button class="btn ghost" type="button" data-close>Cancel</button></div></form>',
      function (m, close) {
        var f = $("#cf", m), er = $("[data-err]", m);
        f.addEventListener("submit", async function (e) {
          e.preventDefault(); var name = f.name.value.trim(); if (!name) { er.textContent = "Please enter a name."; return; }
          var row = { name: name, emoji: f.emoji.value.trim() || null, sort_order: parseInt(f.sort_order.value, 10) || 0, is_active: f.is_active.checked };
          try { await guard(function () { return id ? D.api.update("categories", "id=eq." + encodeURIComponent(id), row) : D.api.insert("categories", row); }); close(); D.toast("Saved"); loadProducts(); } catch (x) { er.textContent = fe(x); }
        });
        var del = $("[data-del]", m); if (del) del.addEventListener("click", async function () {
          if (!confirm("Delete this category? It must have no products.")) return;
          try { await guard(function () { return D.api.remove("categories", "id=eq." + encodeURIComponent(id)); }); close(); D.toast("Deleted"); loadProducts(); } catch (x) { er.textContent = fe(x); }
        });
      });
  }
  async function compress(file) {
    var bmp = await createImageBitmap(file), max = 1000, sc = Math.min(1, max / Math.max(bmp.width, bmp.height));
    var cv = document.createElement("canvas"); cv.width = Math.round(bmp.width * sc); cv.height = Math.round(bmp.height * sc); cv.getContext("2d").drawImage(bmp, 0, 0, cv.width, cv.height);
    function blob(type, q) { return new Promise(function (ok) { cv.toBlob(ok, type, q); }); }
    var type = "image/webp", b = await blob(type, .82); if (!b || b.type !== type) { type = "image/jpeg"; b = await blob(type, .82); }
    var q = .82; while (b.size > 950000 && q > .4) { q -= .1; b = await blob(type, q); }
    if (b.size > 1048576) throw new Error("Image is too large even after compressing. Try a smaller photo.");
    return b;
  }
  async function uploadImage(file) {
    var b = await compress(file), ext = b.type === "image/webp" ? "webp" : "jpg", path = "p-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7) + "." + ext;
    await guard(function () { return D.api.req("POST", "/storage/v1/object/product-images/" + path, b, { "Content-Type": b.type, "x-upsert": "false" }, true); });
    return D.SUPABASE_URL + "/storage/v1/object/public/product-images/" + path;
  }
  function prodForm(id) {
    if (!PD.cats.length) { D.toast("Add a category first"); return; }
    var p = PD.prods.filter(function (x) { return x.id === id; })[0] || {};
    modal("<h3>" + (id ? "Edit product" : "New product") + '</h3><form id="pf" novalidate><label>Category</label><select name="category_id">' + PD.cats.map(function (c) { return '<option value="' + esc(c.id) + '"' + (c.id === (p.category_id || PD.cats[0].id) ? " selected" : "") + ">" + esc(c.name) + "</option>"; }).join("") + "</select>" +
      '<label>Name</label><input name="name" maxlength="100" value="' + esc(p.name || "") + '"><label>Description</label><textarea name="description" rows="2">' + esc(p.description || "") + '</textarea>' +
      '<div class="grid2"><div><label>Price (RWF)</label><input name="price" type="number" min="0" step="50" value="' + esc(p.price != null ? Math.round(p.price) : "") + '"></div><div><label>Order</label><input name="sort_order" type="number" value="' + esc(p.sort_order != null ? p.sort_order : 0) + '"></div></div>' +
      '<div class="grid2"><div><label>Emoji</label><input name="emoji" maxlength="8" value="' + esc(p.emoji || "") + '"></div><div><label>Badge (e.g. Popular)</label><input name="tag" maxlength="20" value="' + esc(p.tag || "") + '"></div></div>' +
      '<label>Photo (optional, auto-compressed)</label><input type="file" name="file" accept="image/*"><input name="image_url" placeholder="or paste an https:// image link" value="' + esc(p.image_url || "") + '" style="margin-top:8px">' +
      '<label class="inline"><input type="checkbox" name="is_active"' + (p.is_active === false ? "" : " checked") + '> Visible on the menu</label><label class="inline"><input type="checkbox" name="is_available"' + (p.is_available === false ? "" : " checked") + '> In stock</label>' +
      '<p class="err" data-err></p><div class="row"><button class="btn primary" type="submit">Save</button><button class="btn ghost" type="button" data-close>Cancel</button></div></form>',
      function (m, close) {
        var f = $("#pf", m), er = $("[data-err]", m);
        f.addEventListener("submit", async function (e) {
          e.preventDefault(); er.textContent = ""; var name = f.name.value.trim(), price = Number(f.price.value);
          if (!name) { er.textContent = "Please enter a name."; return; } if (f.price.value === "" || !(price >= 0)) { er.textContent = "Please enter a valid price."; return; }
          var btn = $("button[type=submit]", f); btn.disabled = true; btn.textContent = "Saving...";
          try {
            var url = f.image_url.value.trim() || null;
            if (f.file.files[0]) url = await uploadImage(f.file.files[0]);
            var row = { category_id: f.category_id.value, name: name, description: f.description.value.trim() || null, price: price, sort_order: parseInt(f.sort_order.value, 10) || 0, emoji: f.emoji.value.trim() || null, tag: f.tag.value.trim() || null, image_url: url, is_active: f.is_active.checked, is_available: f.is_available.checked };
            await guard(function () { return id ? D.api.update("products", "id=eq." + encodeURIComponent(id), row) : D.api.insert("products", row); });
            close(); D.toast("Saved"); loadProducts();
          } catch (x) { er.textContent = fe(x); btn.disabled = false; btn.textContent = "Save"; }
        });
      });
  }

  /* ================= payment methods ================= */
  function renderMethods() {
    var h = '<div class="row" style="justify-content:space-between;align-items:center;margin-bottom:10px"><h3 style="margin:0">Payment methods</h3><button class="btn primary sm" id="addMethod">+ Method</button></div><p class="muted small">Customers see the instructions on checkout and in their order. Turn a method off to hide it. Never put a PIN or password here.</p>';
    h += methods.map(function (m) {
      return '<div class="sec-box" data-mcode="' + esc(m.code) + '"><div class="row" style="justify-content:space-between"><b>' + esc(m.name) + '</b><span class="muted small">' + esc(m.code) + "</span></div>" +
        '<label>Name shown to customers</label><input data-f="name" maxlength="60" value="' + esc(m.name) + '"><label>Instructions</label><textarea data-f="instructions" rows="3">' + esc(m.instructions || "") + '</textarea>' +
        '<div class="row"><label class="inline"><input type="checkbox" data-f="requires_reference"' + (m.requires_reference ? " checked" : "") + '> Customer sends a reference</label><label class="inline"><input type="checkbox" data-f="is_active"' + (m.is_active ? " checked" : "") + '> Active</label></div>' +
        '<button class="btn primary sm" data-msave="' + esc(m.code) + '">Save</button></div>';
    }).join("");
    $("#tabPayments").innerHTML = h;
  }
  function methodForm() {
    modal('<h3>New payment method</h3><form id="mf" novalidate><label>Code (lowercase, e.g. airtel_money)</label><input name="code" maxlength="30"><label>Name</label><input name="name" maxlength="60"><label>Instructions</label><textarea name="instructions" rows="3"></textarea><label class="inline"><input type="checkbox" name="requires_reference" checked> Customer sends a reference</label><p class="err" data-err></p><div class="row"><button class="btn primary" type="submit">Create</button><button class="btn ghost" type="button" data-close>Cancel</button></div></form>', function (m, close) {
      var f = $("#mf", m), er = $("[data-err]", m);
      f.addEventListener("submit", async function (e) {
        e.preventDefault(); var code = f.code.value.trim().toLowerCase(), name = f.name.value.trim();
        if (!/^[a-z0-9_]{2,30}$/.test(code)) { er.textContent = "Code: 2-30 lowercase letters, numbers or underscore."; return; } if (!name) { er.textContent = "Please enter a name."; return; }
        try { await guard(function () { return D.api.insert("payment_methods", { code: code, name: name, instructions: f.instructions.value.trim() || null, requires_reference: f.requires_reference.checked, is_active: true, sort_order: methods.length + 1 }); }); methods = await D.api.get("payment_methods?select=*&order=sort_order.asc"); close(); renderMethods(); D.toast("Created"); }
        catch (x) { er.textContent = fe(x); }
      });
    });
  }

  /* ================= events ================= */
  function bind() {
    $("#loginForm").addEventListener("submit", async function (e) {
      e.preventDefault(); var er = $("#lErr"), b = $("#lBtn"); er.textContent = "";
      var email = $("#lEmail").value.trim().toLowerCase(), pw = $("#lPass").value;
      if (!email || !pw) { er.textContent = "Enter your email and password."; return; }
      b.disabled = true; b.textContent = "Signing in...";
      try { saveSes(toSes(await auth("/auth/v1/token?grant_type=password", "POST", { email: email, password: pw }))); await enter(); $("#lPass").value = ""; }
      catch (x) { er.textContent = x.code === "notadmin" ? x.message : x.code === "network" ? D.friendly(x) : /invalid/i.test(x.message) ? "Wrong email or password." : x.message; }
      finally { b.disabled = false; b.textContent = "Sign in"; }
    });
    $("#forgot").addEventListener("click", async function (e) {
      e.preventDefault(); var email = $("#lEmail").value.trim().toLowerCase(), er = $("#lErr");
      if (!email) { er.textContent = "Type your email above first."; return; }
      try { await auth("/auth/v1/recover?redirect_to=" + encodeURIComponent(location.origin + location.pathname), "POST", { email: email }); er.className = "ok-note"; er.textContent = "If that email is an administrator, a reset link was sent."; } catch (x) { er.className = "err"; er.textContent = D.friendly(x); }
    });
    $("#pwForm").addEventListener("submit", async function (e) {
      e.preventDefault(); var er = $("#pErr"), a = $("#npw").value; er.textContent = "";
      if (a.length < 8) { er.textContent = "Use at least 8 characters."; return; } if (a !== $("#npw2").value) { er.textContent = "The passwords do not match."; return; }
      try { await auth("/auth/v1/user", "PUT", { password: a }, SES.access_token); D.toast("Password saved"); await enter(); } catch (x) { er.textContent = x.code === "notadmin" ? x.message : x.message; }
    });
    $("#logoutBtn").addEventListener("click", function () { logout(); });
    $("#tabs").addEventListener("click", function (e) { var b = e.target.closest("[data-tab]"); if (b) tab(b.getAttribute("data-tab")); });
    $("#stats").addEventListener("click", function (e) { var b = e.target.closest("[data-card]"); if (b) applyCard(+b.getAttribute("data-card")); });
    var ft; $("#filters").addEventListener("input", function () { clearTimeout(ft); ft = setTimeout(function () { readFilters(); loadOrders(); }, 350); });
    $("#filters").addEventListener("submit", function (e) { e.preventDefault(); });
    $("#fClear").addEventListener("click", function () { $("#filters").reset(); readFilters(); loadOrders(); });
    $("#prevP").addEventListener("click", function () { O.offset = Math.max(0, O.offset - O.limit); loadOrders(); });
    $("#nextP").addEventListener("click", function () { O.offset += O.limit; loadOrders(); });
    $("#orows").addEventListener("click", function (e) { var b = e.target.closest("[data-open]"); if (b) openOrder(b.getAttribute("data-open")); });
    $("#dClose").addEventListener("click", closeDrawer); $("#overlay").addEventListener("click", closeDrawer);
    $("#dBody").addEventListener("click", drawerClick);
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !document.querySelector(".modal")) closeDrawer(); });
    $("#tabProducts").addEventListener("click", async function (e) {
      var b = e.target.closest("[data-catedit],[data-pedit],[data-pdel]"); if (!b) return;
      if (b.hasAttribute("data-catedit")) catForm(b.getAttribute("data-catedit")); else if (b.hasAttribute("data-pedit")) prodForm(b.getAttribute("data-pedit"));
      else if (b.hasAttribute("data-pdel")) { var id = b.getAttribute("data-pdel"); if (!confirm("Delete this product? Past orders keep its name and price.")) return; try { await guard(function () { return D.api.remove("products", "id=eq." + encodeURIComponent(id)); }); D.toast("Deleted"); loadProducts(); } catch (x) { D.toast(fe(x)); } }
    });
    $("#tabProducts").addEventListener("change", async function (e) {
      var t = e.target.closest("[data-tog]"); if (!t) return; var patch = {}; patch[t.getAttribute("data-tog")] = t.checked;
      try { await guard(function () { return D.api.update("products", "id=eq." + encodeURIComponent(t.getAttribute("data-id")), patch); }); D.toast("Updated"); } catch (x) { t.checked = !t.checked; D.toast(fe(x)); }
    });
    $("#tabPayments").addEventListener("click", async function (e) {
      if (e.target.id === "addMethod") { methodForm(); return; }
      var b = e.target.closest("[data-msave]"); if (!b) return; var box = b.closest("[data-mcode]"), code = b.getAttribute("data-msave");
      var row = { name: $('[data-f="name"]', box).value.trim(), instructions: $('[data-f="instructions"]', box).value.trim() || null, requires_reference: $('[data-f="requires_reference"]', box).checked, is_active: $('[data-f="is_active"]', box).checked };
      if (!row.name) { D.toast("Please enter a name"); return; }
      try { await guard(function () { return D.api.update("payment_methods", "code=eq." + encodeURIComponent(code), row); }); methods = await D.api.get("payment_methods?select=*&order=sort_order.asc"); D.toast("Saved"); } catch (x) { D.toast(fe(x)); }
    });
  }

  /* ================= boot ================= */
  document.addEventListener("DOMContentLoaded", async function () {
    bind(); show("viewLogin");
    var h = location.hash.replace(/^#/, ""), type = null;
    if (h) {
      var q = new URLSearchParams(h);
      if (q.get("access_token")) { saveSes(toSes({ access_token: q.get("access_token"), refresh_token: q.get("refresh_token"), expires_at: +q.get("expires_at") || 0, expires_in: q.get("expires_in") })); type = q.get("type"); history.replaceState(null, "", location.pathname); }
      else if (q.get("error_description")) { $("#lErr").textContent = q.get("error_description").replace(/\+/g, " "); history.replaceState(null, "", location.pathname); }
    } else { try { SES = JSON.parse(D.store.get("dk_admin_ses", "null")); } catch (e) { SES = null; } }
    if (SES) {
      if (type === "invite" || type === "recovery") { show("viewSetPw"); return; }
      try { await enter(); } catch (e) { $("#lErr").textContent = e.code === "notadmin" ? e.message : ""; show("viewLogin"); }
    }
  });
})();
