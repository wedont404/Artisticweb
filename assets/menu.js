/* DK ARTISTIC HUB - Menu page: categories, search, product cards with photos */
(function () {
  "use strict";
  var D = window.DK, $ = D.$, esc = D.esc, shop = D.shop, S = shop.S;
  var cat = "all", q = "";
  var params = new URLSearchParams(location.search);
  q = (params.get("q") || "").slice(0, 60);
  if (q) $("#search").value = q;

  function renderCats() {
    var all = [{ id: "all", name: "All", emoji: "✨" }].concat(S.cats);
    $("#cats").innerHTML = all.map(function (c) {
      return '<button class="cat' + (c.id === cat ? " on" : "") + '" data-cat="' + esc(c.id) + '" role="tab" aria-selected="' + (c.id === cat) + '">' + esc((c.emoji || "") + " " + c.name) + "</button>";
    }).join("");
  }
  function render() {
    var s = q.trim().toLowerCase();
    var list = S.prods.filter(function (p) {
      return (cat === "all" || p.category_id === cat) && (!s || (p.name + " " + (p.description || "")).toLowerCase().indexOf(s) > -1);
    });
    var h = D.$("#count"); if (h) h.textContent = list.length + " item" + (list.length === 1 ? "" : "s");
    $("#grid").innerHTML = list.length ? list.map(function (p, i) { return shop.cardHTML(p, i); }).join("") : '<div class="empty">Nothing found. Try another word.</div>';
  }

  $("#cats").addEventListener("click", function (e) {
    var b = e.target.closest("[data-cat]"); if (!b) return;
    cat = b.getAttribute("data-cat"); renderCats(); render();
    try { history.replaceState(null, "", cat === "all" ? "menu.html" : "menu.html?cat=" + encodeURIComponent(cat)); } catch (x) {}
  });
  $("#search").addEventListener("input", function (e) { q = e.target.value; render(); });
  shop.tilt($("#grid"));

  function start() {
    $("#grid").innerHTML = '<div class="skel"></div><div class="skel"></div><div class="skel"></div>';
    shop.load().then(function (note) {
      var n = $("#menuNote"); n.hidden = !note; n.textContent = note;
      var want = params.get("cat");
      if (want && S.cats.some(function (c) { return c.id === want; })) cat = want;
      renderCats(); render();
    }).catch(function (e) {
      $("#grid").innerHTML = shop.errorHTML(e);
      var b = $("[data-retry]"); if (b) b.addEventListener("click", start);
    });
  }
  start();
})();
