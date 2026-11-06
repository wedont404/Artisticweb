/* DK ARTISTIC HUB - Checkout page: details, delivery pin on the map, payment method, place the order */
(function () {
  "use strict";
  var D = window.DK, $ = D.$, $$ = D.$$, esc = D.esc, money = D.money, shop = D.shop, S = shop.S;
  var C = { type: "delivery", method: null, loc: null, auto: true, map: null, marker: null, busy: false };
  var NF = "https://nominatim.openstreetmap.org";

  function summary() {
    var T = shop.totals();
    $("#coItems").innerHTML = Object.keys(S.cart).map(function (id) {
      var p = shop.byId(id); if (!p) return "";
      return '<div class="line sm"><div class="th">' + shop.mediaHTML(p) + "</div><div><h4>" + esc(p.name) + "</h4><p>" + S.cart[id] + " &times; " + money(p.price) + "</p></div><b>" + money(p.price * S.cart[id]) + "</b></div>";
    }).join("");
    $("#coTotal").textContent = money(T.sum);
  }
  function renderMethods() {
    if (!S.methods.length) { $("#payMethods").innerHTML = '<p class="muted small">No payment methods are available right now. Please call us.</p>'; return; }
    if (!C.method || !S.methods.some(function (m) { return m.code === C.method; })) C.method = S.methods[0].code;
    $("#payMethods").innerHTML = S.methods.map(function (m) {
      return '<label class="paymeth' + (m.code === C.method ? " on" : "") + '"><input type="radio" name="pm" value="' + esc(m.code) + '"' + (m.code === C.method ? " checked" : "") + '><span><b>' + esc(m.name) + "</b><small>" + esc(m.instructions || "") + "</small></span></label>";
    }).join("");
  }
  function setType(t) {
    C.type = t; $$("#seg button").forEach(function (b) { b.classList.toggle("on", b.getAttribute("data-type") === t); });
    $("#deliveryBox").hidden = t !== "delivery";
    $("#feeNote").textContent = t === "delivery" ? "Delivery fee is confirmed by us after you order. You pay the final total." : "No delivery fee for pickup or dine-in.";
    if (t === "delivery") ensureMap();
  }
  function ensureMap() {
    D.loadMap().then(function (L) {
      if (!C.map) {
        C.map = D.makeMap($("#pickMap"), D.lat, D.lng, 14);
        C.marker = L.marker([D.lat, D.lng], { draggable: true, icon: D.pin("\u{1F4CD}") }).addTo(C.map);
        C.marker.on("dragend", function () { var p = C.marker.getLatLng(); setLoc(p.lat, p.lng, null, true); });
        C.map.on("click", function (e) { setLoc(e.latlng.lat, e.latlng.lng, null, true); });
      }
      setTimeout(function () { C.map.invalidateSize(); }, 400);
    }).catch(function () { $("#locStatus").textContent = "The map could not load. Check your connection and refresh to pin your location."; });
  }
  function setLoc(lat, lng, addr, reverse) {
    C.loc = { lat: lat, lng: lng, confirmed: false };
    if (C.marker) C.marker.setLatLng([lat, lng]);
    if (C.map) C.map.setView([lat, lng], Math.max(C.map.getZoom(), 16));
    if (addr) { $("#cAddr").value = addr; C.auto = true; }
    if (reverse) reverseGeo(lat, lng);
    $("#locStatus").className = "small muted"; $("#locStatus").textContent = "Pin moved. Press Confirm when it is on your door.";
  }
  async function reverseGeo(lat, lng) {
    try {
      var r = await fetch(NF + "/reverse?format=jsonv2&lat=" + lat + "&lon=" + lng); var j = await r.json();
      if (j && j.display_name && (C.auto || !$("#cAddr").value.trim())) { $("#cAddr").value = j.display_name; C.auto = true; }
    } catch (e) { /* address can be typed by hand */ }
  }
  var sT;
  function searchAddr() {
    clearTimeout(sT); var q = $("#addrQ").value.trim();
    if (q.length < 3) { $("#suggest").innerHTML = ""; return; }
    sT = setTimeout(async function () {
      try {
        var r = await fetch(NF + "/search?format=jsonv2&limit=5&countrycodes=rw&q=" + encodeURIComponent(q)); var j = await r.json();
        $("#suggest").innerHTML = (j || []).map(function (x) { return '<button type="button" data-lat="' + esc(x.lat) + '" data-lng="' + esc(x.lon) + '" data-name="' + esc(x.display_name) + '">' + esc(x.display_name) + "</button>"; }).join("") || '<p class="muted small">No matches. Try another name or drop the pin by hand.</p>';
      } catch (e) { $("#suggest").innerHTML = '<p class="muted small">Search is unavailable. Drop the pin by hand.</p>'; }
    }, 600);
  }
  function geo() {
    if (!navigator.geolocation) { $("#locStatus").textContent = "Location is not supported on this device."; return; }
    $("#locStatus").textContent = "Finding you...";
    navigator.geolocation.getCurrentPosition(function (p) { setLoc(p.coords.latitude, p.coords.longitude, null, true); }, function () { $("#locStatus").textContent = "Could not get your location. Search or drop the pin by hand."; }, { enableHighAccuracy: true, timeout: 12000 });
  }
  function confirmLoc() {
    var st = $("#locStatus"), a = $("#cAddr").value.trim();
    if (!C.loc) { st.className = "small err"; st.textContent = "Move the pin to your location first (search, use my location, or drag the pin)."; return; }
    if (!D.inRwanda(C.loc.lat, C.loc.lng)) { st.className = "small err"; st.textContent = "That location is outside Rwanda."; return; }
    if (a.length < 3) { st.className = "small err"; st.textContent = "Please type or confirm your delivery address."; $("#cAddr").focus(); return; }
    C.loc.confirmed = true; st.className = "small ok-note"; st.textContent = "✔ Location confirmed (" + C.loc.lat.toFixed(5) + ", " + C.loc.lng.toFixed(5) + ")";
  }
  function fingerprint(items, phone, name) { return JSON.stringify([items, phone, name, C.type, C.loc && [C.loc.lat, C.loc.lng], C.method, $("#cAddr").value, $("#cInstr").value]); }
  function idemKey(fp) {
    var o = null; try { o = JSON.parse(sessionStorage.getItem("dk_idem") || "null"); } catch (e) {}
    if (o && o.fp === fp) return o.key;
    var k = D.uuid(); try { sessionStorage.setItem("dk_idem", JSON.stringify({ fp: fp, key: k })); } catch (e) {} return k;
  }
  async function placeOrder() {
    if (C.busy) return;
    var err = $("#formErr"); err.textContent = "";
    var name = $("#cName").value.trim(), phone = D.normPhone($("#cPhone").value), items = Object.keys(S.cart).map(function (id) { return { product_id: id, quantity: S.cart[id] }; });
    if (!items.length) { err.textContent = "Your cart is empty."; return; }
    if (name.length < 2) { err.textContent = D.friendly({ code: "invalid_name" }); $("#cName").focus(); return; }
    if (!phone) { err.textContent = D.friendly({ code: "invalid_phone" }); $("#cPhone").focus(); return; }
    if (!C.method) { err.textContent = D.friendly({ code: "invalid_payment_method" }); return; }
    var addr = null, lat = null, lng = null, instr = $("#cInstr").value.trim() || null;
    if (C.type === "delivery") {
      addr = $("#cAddr").value.trim();
      if (!C.loc || !C.loc.confirmed) { err.textContent = "Please confirm your exact location on the map."; return; }
      if (addr.length < 3) { err.textContent = D.friendly({ code: "delivery_address_required" }); return; }
      lat = C.loc.lat; lng = C.loc.lng;
    } else instr = null;
    C.busy = true; var btn = $("#placeBtn"); btn.disabled = true; btn.textContent = "Placing your order...";
    try {
      var res = await D.api.rpc("create_order", {
        p_customer_name: name, p_customer_phone: phone, p_fulfillment_type: C.type, p_delivery_address: addr,
        p_delivery_latitude: lat, p_delivery_longitude: lng, p_google_place_id: null, p_delivery_instructions: instr,
        p_items: items, p_payment_method: C.method, p_idempotency_key: idemKey(fingerprint(items, phone, name))
      });
      var pm = null; S.methods.forEach(function (m) { if (m.code === res.payment_method) pm = m; });
      D.store.set("dk_cust", JSON.stringify({ n: name, p: $("#cPhone").value.trim() }));
      D.store.set("dk_last", JSON.stringify({ o: res.order_number, p: phone }));
      D.store.set("dk_done", JSON.stringify({
        res: res, name: name, phone: phone, type: C.type, addr: addr, lat: lat, lng: lng, instr: instr, method: pm,
        items: items.map(function (i) { var p = shop.byId(i.product_id); return { name: p ? p.name : "item", quantity: i.quantity }; })
      }));
      try { sessionStorage.removeItem("dk_idem"); } catch (e) {}
      S.cart = {}; shop.saveCart();
      location.href = "done.html";
    } catch (e) {
      err.textContent = D.friendly(e);
      if (e.code === "item_unavailable") {
        shop.load().then(function () {
          if (!Object.keys(S.cart).length) { $("#coBox").hidden = true; $("#coEmpty").hidden = false; $("#coEmptyMsg").textContent = "Sorry, an item in your cart just sold out and was removed. Your cart is now empty."; }
          else summary();
        });
      }
      C.busy = false; btn.disabled = false; btn.textContent = "Place order";
    }
  }

  function bind() {
    $("#seg").addEventListener("click", function (e) { var b = e.target.closest("[data-type]"); if (b) setType(b.getAttribute("data-type")); });
    $("#placeBtn").addEventListener("click", placeOrder);
    $("#payMethods").addEventListener("change", function (e) { if (e.target.name === "pm") { C.method = e.target.value; $$(".paymeth").forEach(function (l) { l.classList.toggle("on", l.querySelector("input").checked); }); } });
    $("#addrQ").addEventListener("input", searchAddr);
    $("#suggest").addEventListener("click", function (e) { var b = e.target.closest("[data-lat]"); if (!b) return; setLoc(+b.getAttribute("data-lat"), +b.getAttribute("data-lng"), b.getAttribute("data-name"), false); $("#suggest").innerHTML = ""; });
    $("#cAddr").addEventListener("input", function () { C.auto = false; });
    $("#geoBtn").addEventListener("click", geo); $("#confirmLoc").addEventListener("click", confirmLoc);
  }

  function start() {
    shop.load().then(function () {
      if (!Object.keys(S.cart).length) { $("#coBox").hidden = true; $("#coEmpty").hidden = false; return; }
      var c = null; try { c = JSON.parse(D.store.get("dk_cust", "null")); } catch (e) {}
      if (c) { $("#cName").value = c.n || ""; $("#cPhone").value = c.p || ""; }
      summary(); renderMethods(); setType("delivery"); bind();
      $("#coBox").hidden = false; $("#coLoad").hidden = true;
      shop.onCart = summary;
    }).catch(function (e) {
      $("#coLoad").innerHTML = shop.errorHTML(e);
      var b = $("[data-retry]"); if (b) b.addEventListener("click", function () { location.reload(); });
    });
  }
  start();
})();
