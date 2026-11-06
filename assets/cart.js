/* DK ARTISTIC HUB - Cart page */
(function () {
  "use strict";
  var D = window.DK, $ = D.$, esc = D.esc, money = D.money, shop = D.shop, S = shop.S;

  function draw() {
    var ids = Object.keys(S.cart), T = shop.totals();
    $("#cartTotal").textContent = money(T.sum);
    $("#cartSub").textContent = T.n + " item" + (T.n === 1 ? "" : "s");
    if (!ids.length) {
      $("#cartList").innerHTML = '<div class="cart-empty"><div>&#128722;</div><p>Your cart is empty.<br>Add something tasty!</p><a class="btn primary" href="menu.html" style="margin-top:14px">Browse the menu</a></div>';
      $("#cartFoot").hidden = true; return;
    }
    $("#cartList").innerHTML = ids.map(function (id) {
      var p = shop.byId(id); if (!p) return "";
      return '<div class="line"><div class="th">' + shop.mediaHTML(p) + "</div><div><h4>" + esc(p.name) + "</h4><p>" + money(p.price) + " &times; " + S.cart[id] + " = " + money(p.price * S.cart[id]) +
        '</p></div><div class="stepper"><button data-dec="' + esc(id) + '" aria-label="Less">&minus;</button><b>' + S.cart[id] + '</b><button data-inc="' + esc(id) + '" aria-label="More">+</button></div></div>';
    }).join("");
    $("#cartFoot").hidden = false;
  }
  shop.onCart = draw;

  function start() {
    $("#cartList").innerHTML = '<div class="skel" style="height:120px"></div>';
    shop.load().then(function (note) { var n = $("#menuNote"); n.hidden = !note; n.textContent = note; draw(); }).catch(function (e) {
      $("#cartList").innerHTML = shop.errorHTML(e);
      var b = $("[data-retry]"); if (b) b.addEventListener("click", start);
    });
  }
  start();
})();
