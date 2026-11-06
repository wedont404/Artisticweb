/* DK ARTISTIC HUB - Home page: live open/happy-hour chips, 3D spinning menu, crowd favourites, mood picker */
(function () {
  "use strict";
  var D = window.DK, $ = D.$, $$ = D.$$, esc = D.esc, money = D.money, shop = D.shop, S = shop.S;

  /* ---------------- live open / happy hour / day part (time dimension) ---------------- */
  function live() {
    var k = D.kigali(), open = k.h >= D.openHour && k.h < D.closeHour;
    $("#openChip .dot").classList.toggle("off", !open);
    $("#openTxt").textContent = open ? "Open now until " + D.closeHour + ":00" : "Closed. Opens at " + D.openHour + ":00";
    var hf = D.happyFrom * 60, ht = D.happyTo * 60, t;
    function hm(m) { return (m >= 60 ? Math.floor(m / 60) + "h " : "") + (m % 60) + "m"; }
    if (k.mins >= hf && k.mins < ht) t = "Happy hour ends in " + hm(ht - k.mins);
    else if (k.mins < hf) t = "Happy hour starts in " + hm(hf - k.mins);
    else t = "Happy hour " + D.happyFrom + ":00-" + D.happyTo + ":00 tomorrow";
    $("#happyTxt").textContent = t;
    document.body.setAttribute("data-daypart", k.h < 11 ? "morning" : k.h < 17 ? "day" : k.h < 20 ? "evening" : "night");
  }

  /* ---------------- 3D ring ---------------- */
  var ringRot = 0, ringVel = 0, dragging = false, ringOn = true;
  function buildRing() {
    var ring = $("#ring"), list = S.prods.filter(function (p) { return p.is_available; });
    list.sort(function (a, b) { return (b.tag ? 1 : 0) - (a.tag ? 1 : 0); });
    list = list.slice(0, 8);
    if (list.length < 3) { $("#scene").hidden = true; return; }
    $("#scene").hidden = false;
    var n = list.length, w = innerWidth < 560 ? 132 : 170, r = Math.round((w / 2) / Math.tan(Math.PI / n)) + 26;
    ring.innerHTML = list.map(function (p, i) {
      var e = shop.emojiOf(p);
      return '<div class="face" style="transform:rotateY(' + (i * 360 / n) + 'deg) translateZ(' + r + 'px)">' +
        (shop.photo(p) ? '<img src="' + esc(shop.photo(p)) + '" alt="' + esc(p.name) + '" loading="lazy" data-e="' + esc(e) + '">' : '<div class="fe">' + esc(e) + "</div>") +
        "<h4>" + esc(p.name) + '</h4><span class="price">' + money(p.price) + '</span><button class="add" data-add="' + esc(p.id) + '">+ Add</button></div>';
    }).join("");
  }
  function ringLoop() {
    if (!dragging && ringOn && !document.hidden) { ringRot += (D.reduce ? 0 : 0.2) + ringVel; ringVel *= 0.94; }
    var r = $("#ring"); if (r) r.style.transform = "rotateY(" + ringRot + "deg)";
    requestAnimationFrame(ringLoop);
  }
  function heroFx() {
    var scene = $("#scene"), stage = $("#stage"), hero = $("#heroSec"), lx = 0, floats = $$(".float");
    scene.addEventListener("pointerdown", function (e) { if (e.target.closest("button")) return; dragging = true; lx = e.clientX; ringVel = 0; try { scene.setPointerCapture(e.pointerId); } catch (x) {} });
    scene.addEventListener("pointermove", function (e) { if (!dragging) return; var dx = e.clientX - lx; lx = e.clientX; ringRot += dx * 0.45; ringVel = dx * 0.25; });
    function up() { dragging = false; }
    scene.addEventListener("pointerup", up); scene.addEventListener("pointercancel", up);
    function tilt(nx, ny) {
      stage.style.setProperty("--ty", (nx * 9).toFixed(2) + "deg"); stage.style.setProperty("--tx", (-ny * 6).toFixed(2) + "deg");
      floats.forEach(function (f) { var d = +f.getAttribute("data-depth") || 20; f.style.transform = "translate(" + (nx * d).toFixed(1) + "px," + (ny * d).toFixed(1) + "px)"; });
    }
    if (!D.reduce) {
      hero.addEventListener("pointermove", function (e) { if (e.pointerType === "touch") return; var b = hero.getBoundingClientRect(); tilt(((e.clientX - b.left) / b.width - .5) * 2, ((e.clientY - b.top) / b.height - .5) * 2); });
      window.addEventListener("deviceorientation", function (e) { if (e.gamma == null) return; tilt(Math.max(-1, Math.min(1, e.gamma / 30)), Math.max(-1, Math.min(1, ((e.beta || 45) - 45) / 30))); });
    }
    if ("IntersectionObserver" in window) new IntersectionObserver(function (en) { ringOn = en[0].isIntersecting; }).observe(hero);
    ringLoop();
    var words = ["Brochettes", "Burgers", "Loaded Fries", "Cold Beers", "Cocktails"], wi = 0, el = $("#rot");
    if (!D.reduce) setInterval(function () { el.classList.add("out"); setTimeout(function () { wi = (wi + 1) % words.length; el.textContent = words[wi]; el.classList.remove("out"); }, 300); }, 2200);
  }

  /* ---------------- crowd favourites + category tiles ---------------- */
  function favourites() {
    var list = S.prods.filter(function (p) { return p.is_available; });
    list.sort(function (a, b) { return (b.tag ? 1 : 0) - (a.tag ? 1 : 0); });
    list = list.slice(0, 4);
    $("#fav").innerHTML = list.length ? list.map(function (p, i) { return shop.cardHTML(p, i); }).join("") : '<div class="empty">The menu is empty for now.</div>';
    shop.tilt($("#fav"));
    $("#catTiles").innerHTML = S.cats.map(function (c) {
      var n = S.prods.filter(function (p) { return p.category_id === c.id; }).length;
      return '<a class="card cat-tile reveal" href="menu.html?cat=' + encodeURIComponent(c.id) + '"><span>' + esc(c.emoji || "\u{1F37D}️") + "</span><b>" + esc(c.name) + "</b><small>" + n + " item" + (n === 1 ? "" : "s") + "</small></a>";
    }).join("");
    D.reveal();
  }

  /* ---------------- mood / surprise ---------------- */
  var MOODS = { hungry: ["brochette", "burger"], chill: ["beer"], party: ["cocktail", "beer"], snack: ["side", "fries"] };
  var rolling = false;
  function surprise(mood) {
    if (rolling) return;
    var pool = S.prods.filter(function (p) {
      if (!p.is_available) return false; if (!mood) return true;
      var n = ((shop.catOf(p.category_id) || {}).name || "").toLowerCase();
      return MOODS[mood].some(function (k) { return n.indexOf(k) > -1; });
    });
    if (!pool.length) pool = S.prods.filter(function (p) { return p.is_available; });
    if (!pool.length) { D.toast("The menu is still loading"); return; }
    rolling = true; var box = $("#result"), n = 0, steps = D.reduce ? 1 : 14;
    $("#fun").scrollIntoView({ behavior: D.reduce ? "auto" : "smooth", block: "center" });
    (function tick() {
      var p = pool[Math.floor(Math.random() * pool.length)], last = ++n >= steps;
      var pic = shop.photo(p) ? '<div class="pickpic"><img src="' + esc(shop.photo(p)) + '" alt="' + esc(p.name) + '" data-e="' + esc(shop.emojiOf(p)) + '"></div>' : '<div class="big">' + esc(shop.emojiOf(p)) + "</div>";
      box.innerHTML = '<div class="pick">' + pic + "<h3>" + esc(p.name) + "</h3>" +
        (last ? '<p class="muted">' + esc(p.description || "") + '</p><p class="price">' + money(p.price) + '</p><button class="btn primary" data-add="' + esc(p.id) + '">+ Add to cart</button>' : "") + "</div>";
      if (last) { rolling = false; if (!D.reduce) D.confetti(40); } else setTimeout(tick, 60 + n * 14);
    })();
  }

  /* ---------------- start ---------------- */
  $("#areaTxt").textContent = D.area;
  live(); setInterval(live, 30000); heroFx();
  $("#moods").addEventListener("click", function (e) { var b = e.target.closest("[data-mood]"); if (!b) return; $$("#moods button").forEach(function (x) { x.classList.toggle("on", x === b); }); surprise(b.getAttribute("data-mood")); });
  $("#surprise").addEventListener("click", function () { $$("#moods button").forEach(function (x) { x.classList.remove("on"); }); surprise(null); });
  $("#surpriseTop").addEventListener("click", function () { surprise(null); });
  var taps = 0, tt;
  $("#logoTap").addEventListener("click", function (e) { e.preventDefault(); taps++; clearTimeout(tt); tt = setTimeout(function () { taps = 0; }, 900); if (taps >= 5) { taps = 0; D.confetti(220); D.toast("You found the secret! Mention it for a surprise."); } else if (taps === 1) { setTimeout(function () { if (taps === 1) { /* single tap = go home (already here) */ window.scrollTo({ top: 0, behavior: D.reduce ? "auto" : "smooth" }); } }, 950); } });

  function loadAll() {
    $("#fav").innerHTML = '<div class="skel"></div><div class="skel"></div><div class="skel"></div><div class="skel"></div>';
    shop.load().then(function () { buildRing(); favourites(); }).catch(function (e) {
      $("#scene").hidden = true; $("#fav").innerHTML = shop.errorHTML(e);
      var b = $("[data-retry]"); if (b) b.addEventListener("click", loadAll);
    });
  }
  shop.onCart = function () {};
  loadAll();

  /* preloader: only the first visit of a session */
  var pre = $("#preloader"), seen = false;
  try { seen = sessionStorage.getItem("dk_pre") === "1"; sessionStorage.setItem("dk_pre", "1"); } catch (e) {}
  if (seen) pre.classList.add("done");
  else {
    var t0 = Date.now();
    var hide = function () { setTimeout(function () { pre.classList.add("done"); }, Math.max(0, 700 - (Date.now() - t0))); };
    if (document.readyState === "complete") hide(); else window.addEventListener("load", hide);
    setTimeout(function () { pre.classList.add("done"); }, 4000);
  }
})();
