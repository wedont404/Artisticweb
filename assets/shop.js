/* DK ARTISTIC HUB - shared shop layer used by Home, Menu, Cart and Checkout:
   loads the live menu, keeps the cart in the phone, draws product cards (with photos). */
(function () {
  "use strict";
  var D = window.DK, $ = D.$, $$ = D.$$, esc = D.esc, money = D.money;
  var S = { cats: [], prods: [], methods: [], cart: {} };
  var shop = (D.shop = { S: S, onCart: null });

  try { S.cart = JSON.parse(D.store.get("dk_cart2", "{}")) || {}; } catch (e) { S.cart = {}; }
  function saveCart() { D.store.set("dk_cart2", JSON.stringify(S.cart)); D.badges(); }
  shop.saveCart = saveCart;
  shop.byId = function (id) { for (var i = 0; i < S.prods.length; i++) if (S.prods[i].id === id) return S.prods[i]; return null; };
  shop.catOf = function (id) { for (var i = 0; i < S.cats.length; i++) if (S.cats[i].id === id) return S.cats[i]; return null; };
  shop.emojiOf = function (p) { return p.emoji || (shop.catOf(p.category_id) || {}).emoji || "\u{1F37D}️"; };

  /* Photo address: a photo uploaded in the admin page wins; otherwise img/menu/<item-name>.jpg
     (drop your JPG in that folder with the item's name, e.g. "Chicken Burger" -> chicken-burger.jpg).
     If the file does not exist the card shows its emoji tile (see core.js), so nothing ever looks broken. */
  shop.photo = function (p) {
    if (p.image_url) return p.image_url;
    var slug = String(p.name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return slug ? "img/menu/" + slug + ".jpg" : "";
  };
  shop.mediaHTML = function (p) {
    var e = shop.emojiOf(p), u = shop.photo(p);
    return u ? '<img src="' + esc(u) + '" alt="' + esc(p.name) + '" loading="lazy" decoding="async" width="400" height="300" data-e="' + esc(e) + '">' : "<span>" + esc(e) + "</span>";
  };
  shop.actionHTML = function (p) {
    if (!p.is_available) return '<button class="add" disabled>Sold out</button>';
    var q = S.cart[p.id] || 0;
    if (!q) return '<button class="add" data-add="' + esc(p.id) + '">+ Add</button>';
    return '<div class="stepper"><button data-dec="' + esc(p.id) + '" aria-label="Less">&minus;</button><b>' + q + '</b><button data-inc="' + esc(p.id) + '" aria-label="More">+</button></div>';
  };
  shop.cardHTML = function (p, i) {
    return '<article class="card item" style="animation-delay:' + Math.min(i || 0, 8) * 50 + 'ms" data-id="' + esc(p.id) + '">' +
      (p.tag ? '<span class="tag">' + esc(p.tag) + "</span>" : "") + '<div class="media">' + shop.mediaHTML(p) + "</div>" +
      '<div class="item-body"><h3>' + esc(p.name) + "</h3><p>" + esc(p.description || "") + "</p>" +
      '<div class="price-row"><span class="price">' + money(p.price) + '</span><span class="act">' + shop.actionHTML(p) + "</span></div></div></article>";
  };
  shop.syncCards = function () { $$(".item").forEach(function (c) { var p = shop.byId(c.getAttribute("data-id")); if (p) $(".act", c).innerHTML = shop.actionHTML(p); }); };
  shop.tilt = function (el) {
    if (!el || D.reduce || !matchMedia("(hover:hover)").matches) return;
    el.addEventListener("pointermove", function (e) { var c = e.target.closest(".item"); if (!c) return; var r = c.getBoundingClientRect(); c.style.setProperty("--ry", ((e.clientX - r.left) / r.width - .5) * 9 + "deg"); c.style.setProperty("--rx", (-((e.clientY - r.top) / r.height - .5)) * 9 + "deg"); });
    el.addEventListener("pointerout", function (e) { var c = e.target.closest(".item"); if (c) { c.style.setProperty("--rx", "0deg"); c.style.setProperty("--ry", "0deg"); } });
  };

  /* live menu from Supabase; the last good copy is kept so the menu still shows with a weak connection */
  shop.load = async function () {
    var r, note = "";
    try {
      r = await Promise.all([
        D.api.get("categories?select=id,name,emoji,sort_order&is_active=eq.true&order=sort_order.asc"),
        D.api.get("products?select=id,category_id,name,description,price,image_url,emoji,tag,is_available,sort_order&is_active=eq.true&order=sort_order.asc"),
        D.api.get("payment_methods?select=code,name,instructions,requires_reference&is_active=eq.true&order=sort_order.asc")
      ]);
      D.store.set("dk_menu_cache", JSON.stringify(r));
    } catch (e) {
      var c = null; try { c = JSON.parse(D.store.get("dk_menu_cache", "null")); } catch (x) {}
      if (!c) throw e;
      r = c; note = "Showing the last saved menu. " + D.friendly(e);
    }
    S.cats = r[0]; S.prods = r[1]; S.methods = r[2];
    Object.keys(S.cart).forEach(function (id) { var p = shop.byId(id); if (!p || !p.is_available || !(S.cart[id] > 0)) delete S.cart[id]; });
    saveCart();
    return note;
  };
  shop.errorHTML = function (e) {
    return '<div class="empty">Could not load the menu.<br><span class="small">' + esc(D.friendly(e)) + '</span><br><br>' +
      '<button class="btn primary" data-retry>Try again</button> <a class="btn ghost" href="https://wa.me/' + D.whatsapp + '" target="_blank" rel="noopener">Order on WhatsApp</a></div>';
  };

  /* cart */
  shop.totals = function () { var n = 0, s = 0; Object.keys(S.cart).forEach(function (id) { var p = shop.byId(id); if (p) { n += S.cart[id]; s += S.cart[id] * Number(p.price); } }); return { n: n, sum: s }; };
  shop.setQty = function (id, q) {
    if (q <= 0) delete S.cart[id]; else S.cart[id] = Math.min(q, 99);
    saveCart(); shop.syncCards(); if (shop.onCart) shop.onCart();
  };
  function bump(sel) { $$(sel).forEach(function (el) { el.classList.remove("bump"); void el.offsetWidth; el.classList.add("bump"); }); }

  document.addEventListener("click", function (e) {
    var b = e.target.closest("[data-add],[data-inc],[data-dec]"); if (!b) return;
    if (b.hasAttribute("data-add")) {
      var id = b.getAttribute("data-add"), p = shop.byId(id); if (!p) return;
      shop.setQty(id, (S.cart[id] || 0) + 1); bump("#cartBtn,.tab-n"); D.toast("Added " + p.name);
    } else if (b.hasAttribute("data-inc")) { var a = b.getAttribute("data-inc"); shop.setQty(a, (S.cart[a] || 0) + 1); }
    else { var d = b.getAttribute("data-dec"); shop.setQty(d, (S.cart[d] || 0) - 1); }
  });
})();
