/* DK ARTISTIC HUB - How to order + Visit pages (static business info and the map) */
(function () {
  "use strict";
  var D = window.DK, $ = D.$;
  function set(id, fn) { var e = $("#" + id); if (e) fn(e); }
  set("ussdText", function (e) { e.textContent = D.ussd; });
  set("dialBtn", function (e) { e.href = "tel:" + D.ussd.replace(/\*/g, "%2A").replace(/#/g, "%23"); });
  set("copyBtn", function (e) { e.addEventListener("click", function () { D.copy(D.ussd); }); });
  set("vArea", function (e) { e.textContent = D.area; });
  set("vPlus", function (e) { e.textContent = "Plus code: " + D.plusCode; });
  set("vHours", function (e) { e.textContent = D.openHour + ":00 - " + D.closeHour + ":00 daily"; });
  set("vHappy", function (e) { e.textContent = D.happyFrom + ":00 - " + D.happyTo + ":00 (drinks only)"; });
  set("vPhone", function (e) { e.textContent = D.phoneDisplay; });
  set("mapBtn", function (e) { e.href = D.gmaps(D.lat, D.lng); });
  set("callBtn", function (e) { e.href = "tel:+" + D.whatsapp; });
  set("waBtn", function (e) { e.href = "https://wa.me/" + D.whatsapp + "?text=" + encodeURIComponent("Hello DK Artistic Hub"); });
  set("visitMap", function (el) {
    D.loadMap().then(function (L) {
      var m = D.makeMap(el, D.lat, D.lng, 16);
      L.marker([D.lat, D.lng], { icon: D.pin("\u{1F362}") }).addTo(m).bindPopup("DK ARTISTIC HUB");
    }).catch(function () { el.hidden = true; });
  });
})();
