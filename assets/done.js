/* DK ARTISTIC HUB - "Order placed" page: payment help, MoMo reference, WhatsApp, tracking link */
(function () {
  "use strict";
  var D = window.DK, $ = D.$, esc = D.esc, money = D.money;
  var L = null;
  try { L = JSON.parse(D.store.get("dk_done", "null")); } catch (e) { L = null; }
  if (!L || !L.res) { $("#doneBox").hidden = true; $("#doneNone").hidden = false; return; }

  var r = L.res, m = L.method;
  function dialHref() { return "tel:" + D.ussd.replace(/\*/g, "%2A").replace(/#/g, "%23"); }

  $("#doneRef").textContent = r.order_number + " · " + money(r.subtotal) + (L.type === "delivery" ? " + delivery fee" : "");
  var html = "<b>Payment: " + esc(r.payment_method_name || (m && m.name) || "") + "</b><p class=\"muted small\" style=\"margin-top:6px\">" + esc(r.payment_instructions || (m && m.instructions) || "") + "</p>";
  if (r.payment_method === "mtn_momo") {
    html += '<div class="center"><div class="code">' + esc(D.ussd) + '</div><div class="pay-btns" style="justify-content:center"><a class="btn primary sm" href="' + dialHref() + '">&#128222; Dial to pay</a><button class="btn ghost sm" id="doneCopy" type="button">Copy code</button></div>' +
      '<p class="muted small" style="margin-top:8px">Pay after we confirm your total (delivery fee included).</p></div>';
  }
  $("#donePay").innerHTML = html;
  var dc = $("#doneCopy"); if (dc) dc.addEventListener("click", function () { D.copy(D.ussd); });

  var needRef = m ? !!m.requires_reference : r.payment_method !== "cash_on_delivery";
  $("#refBox").hidden = !needRef;

  var lines = (L.items || []).map(function (i) { return "• " + i.quantity + " x " + i.name; });
  var msg = "NEW ORDER " + r.order_number + "\nName: " + L.name + "\nPhone: " + L.phone + "\nType: " + String(L.type).replace("_", "-") +
    (L.addr ? "\nAddress: " + L.addr + "\nMap: " + D.gmaps(L.lat, L.lng) : "") + "\n\n" + lines.join("\n") + "\n\nSubtotal: " + money(r.subtotal) + (L.instr ? "\nNotes: " + L.instr : "") + "\nPayment: " + (r.payment_method_name || "");
  $("#waOrder").href = "https://wa.me/" + D.whatsapp + "?text=" + encodeURIComponent(msg);
  $("#trackLink").href = "track.html?o=" + encodeURIComponent(r.order_number);

  $("#refBtn").addEventListener("click", async function () {
    var ref = $("#refInput").value.trim(), er = $("#refErr"); er.textContent = "";
    if (!/^[A-Za-z0-9._-]{4,64}$/.test(ref)) { er.textContent = D.friendly({ code: "invalid_reference" }); return; }
    var b = $("#refBtn"); b.disabled = true;
    try {
      var x = await D.api.rpc("submit_payment_reference", { p_order_number: r.order_number, p_phone: L.phone, p_reference: ref });
      if (!x || !x.found) er.textContent = "We could not match this order. Please contact us.";
      else { $("#refBox").innerHTML = '<p class="ok-note">&#10004; Reference received. We will verify your payment shortly. It shows as "pending verification" until we do.</p>'; D.toast("Reference sent"); }
    } catch (e) { er.textContent = D.friendly(e); } finally { b.disabled = false; }
  });

  D.confetti();
})();
