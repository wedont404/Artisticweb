/* DK ARTISTIC HUB - customer tracking (order number + phone, verified by the database) */
(function () {
  "use strict";
  var D = window.DK, $ = D.$, esc = D.esc, money = D.money;
  var cur = null, timer = null, map = null, pins = {}, STEPS = [
    ["confirmed", "Confirmed", "✅"], ["preparing", "Preparing", "\u{1F373}"], ["ready", "Ready", "\u{1F6CE}️"],
    ["out_for_delivery", "On the way", "\u{1F6F5}"], ["delivered", "Delivered", "\u{1F389}"]
  ];
  var LABEL = { pending: "Pending", confirmed: "Confirmed", preparing: "Preparing", ready: "Ready", out_for_delivery: "Out for delivery", delivered: "Delivered", cancelled: "Cancelled",
    unpaid: "Unpaid", pending_verification: "Payment being verified", paid: "Paid", failed: "Payment failed", refunded: "Refunded" };

  function chip(el, v) { el.className = "chip c-" + v; el.textContent = LABEL[v] || v; }
  async function lookup(num, phone, silent) {
    var err = $("#tErr"); if (!silent) err.textContent = "";
    var n = String(num || "").trim().toUpperCase(), p = D.normPhone(phone);
    if (!/^DK-\d{4}-\d{5}$/.test(n)) { err.textContent = "Enter the order number like DK-2026-00001."; return; }
    if (!p) { err.textContent = D.friendly({ code: "invalid_phone" }); return; }
    var btn = $("#tBtn"); if (!silent) { btn.disabled = true; btn.textContent = "Looking..."; }
    try {
      var r = await D.api.rpc("track_order", { p_order_number: n, p_phone: p });
      if (!r || !r.found) { err.textContent = "We could not find that order. Check the order number and the phone number you used."; stop(); $("#result").hidden = true; return; }
      cur = { n: n, p: p }; D.store.set("dk_last", JSON.stringify({ o: n, p: p }));
      render(r); schedule(r);
    } catch (e) { if (!silent) err.textContent = D.friendly(e); else $("#refreshNote").textContent = "Could not refresh. " + D.friendly(e); }
    finally { if (!silent) { btn.disabled = false; btn.textContent = "Track order"; } }
  }
  function stop() { clearInterval(timer); timer = null; }
  function schedule(r) {
    stop();
    if (r.order_status === "delivered" || r.order_status === "cancelled") { $("#refreshNote").textContent = ""; return; }
    $("#refreshNote").textContent = "This page refreshes by itself every 20 seconds.";
    timer = setInterval(function () { if (!document.hidden && cur) lookup(cur.n, cur.p, true); }, 20000);
  }
  function render(r) {
    $("#result").hidden = false; $("#rNum").textContent = r.order_number;
    chip($("#rStatus"), r.order_status); chip($("#rPay"), r.payment_status);
    var avail = !!r.tracking_available;
    $("#waiting").hidden = avail; $("#trackBox").hidden = !avail; $("#detail").hidden = !avail;
    if (!avail) {
      $("#waitMsg").textContent = r.message === "cancelled" ? "This order was cancelled. Please contact us if you have questions."
        : "We received your order and are checking it. Live tracking opens as soon as we confirm it. This page updates by itself.";
      destroyMap(); return;
    }
    var idx = -1; STEPS.forEach(function (s, i) { if (s[0] === r.order_status) idx = i; });
    var cancelled = r.order_status === "cancelled";
    var steps = STEPS.filter(function (s) { return r.fulfillment_type === "delivery" || s[0] !== "out_for_delivery"; });
    idx = -1; steps.forEach(function (s, i) { if (s[0] === r.order_status) idx = i; });
    $("#stepper").style.gridTemplateColumns = "repeat(" + steps.length + ",1fr)";
    $("#stepper").innerHTML = steps.map(function (s, i) {
      var cls = cancelled ? "" : i < idx || r.order_status === "delivered" ? "done" : i === idx ? "now done" : "";
      return '<div class="st ' + cls + '"><i>' + s[2] + "</i>" + s[1] + "</div>";
    }).join("");
    $("#etaLine").innerHTML = cancelled ? "<b>This order was cancelled.</b>" : r.order_status === "delivered" ? "<b>Delivered. Enjoy your meal!</b>" : r.estimated_delivery_at ? "Estimated time: <b>" + esc(D.fmtDate(r.estimated_delivery_at)) + "</b>" : "";
    $("#updLine").textContent = "Last updated " + D.fmtDate(r.last_updated);

    $("#itemsTbl").innerHTML = '<tr><th>Item</th><th class="r">Qty</th><th class="r">Price</th></tr>' + (r.items || []).map(function (i) {
      return "<tr><td>" + esc(i.name) + '</td><td class="r">' + i.quantity + '</td><td class="r">' + money(i.total_price) + "</td></tr>";
    }).join("");
    $("#sums").innerHTML = "<dt>Subtotal</dt><dd>" + money(r.subtotal) + "</dd><dt>Delivery fee</dt><dd>" + (r.fulfillment_type === "delivery" ? money(r.delivery_fee) : "None") + "</dd><dt>Total</dt><dd>" + money(r.total_amount) + "</dd>" +
      "<dt>Payment</dt><dd>" + esc(r.payment_method || "") + " &middot; " + esc(LABEL[r.payment_status] || r.payment_status) + "</dd>";
    var ph = $("#payHelp");
    if (r.payment_status === "unpaid" && r.payment_instructions) {
      var dial = /MTN/i.test(r.payment_method || "") ? '<p class="center"><span class="code">' + esc(D.ussd) + '</span></p><p class="center"><a class="btn primary sm" href="tel:' + D.ussd.replace(/\*/g, "%2A").replace(/#/g, "%23") + '">Dial to pay</a></p>' : "";
      ph.hidden = false; ph.innerHTML = "<b>How to pay</b><p class=\"muted small\">" + esc(r.payment_instructions) + "</p>" + dial;
    } else if (r.payment_status === "pending_verification") { ph.hidden = false; ph.innerHTML = "<b>Thank you!</b><p class=\"muted small\">We received your payment reference and are verifying it.</p>"; }
    else ph.hidden = true;

    $("#log").innerHTML = (r.progress || []).slice().reverse().map(function (h) {
      return "<li><b>" + esc(LABEL[h.status] || h.status) + "</b> <span class=\"muted small\">" + esc(D.fmtDate(h.at)) + "</span>" + (h.note ? "<br>" + esc(h.note) : "") + "</li>";
    }).join("");
    drawMap(r);
  }
  function destroyMap() { if (map) { map.remove(); map = null; pins = {}; } }
  function drawMap(r) {
    var has = r.fulfillment_type === "delivery" && r.delivery_latitude != null;
    $("#mapCard").hidden = !has; if (!has) return;
    var cp = r.courier_position;
    $("#mapNote").textContent = cp ? "The rider's position is set by our team and updates when they post progress." : "Your delivery location.";
    D.loadMap().then(function (L) {
      var dl = [+r.delivery_latitude, +r.delivery_longitude];
      if (!map) { map = D.makeMap($("#tMap"), dl[0], dl[1], 15); pins = {}; }
      if (!pins.home) pins.home = L.marker(dl, { icon: D.pin("\u{1F3E0}") }).addTo(map).bindPopup("Delivery location");
      if (cp) {
        var cl = [+cp.latitude, +cp.longitude];
        if (!pins.rider) pins.rider = L.marker(cl, { icon: D.pin("\u{1F6F5}") }).addTo(map).bindPopup("Rider (last update)"); else pins.rider.setLatLng(cl);
        map.fitBounds(L.latLngBounds([dl, cl]).pad(0.3));
      } else if (pins.rider) { map.removeLayer(pins.rider); delete pins.rider; }
      setTimeout(function () { map.invalidateSize(); }, 200);
    }).catch(function () { $("#mapNote").textContent = "The map could not load."; });
  }

  document.addEventListener("DOMContentLoaded", function () {
    var q = new URLSearchParams(location.search), last = null;
    try { last = JSON.parse(D.store.get("dk_last", "null")); } catch (e) {}
    var o = q.get("o") || (last && last.o) || "";
    $("#tOrder").value = o;
    if (last && (!q.get("o") || q.get("o") === last.o)) $("#tPhone").value = D.phoneShow(last.p);
    $("#lookup").addEventListener("submit", function (e) { e.preventDefault(); lookup($("#tOrder").value, $("#tPhone").value, false); });
    if (o && last && last.o === o && last.p) lookup(o, last.p, false);
  });
})();
