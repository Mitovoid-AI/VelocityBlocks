(function () {
  "use strict";
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var SVGNS = "http://www.w3.org/2000/svg";

  // ------------------------------------------------------------ day / night
  var root = document.documentElement;
  var themeBtn = document.getElementById("theme");
  var meta = document.querySelector('meta[name="theme-color"]');
  function current() { return root.getAttribute("data-theme") === "light" ? "light" : "dark"; }
  function syncTheme() {
    var t = current();
    themeBtn.setAttribute("aria-label", t === "dark" ? "Switch to light mode" : "Switch to dark mode");
    if (meta) meta.setAttribute("content", t === "dark" ? "#0b1020" : "#f5f7fc");
  }
  themeBtn.addEventListener("click", function () {
    var t = current() === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", t);
    try { localStorage.setItem("vb-site-theme", t); } catch (e) {}
    syncTheme();
  });
  syncTheme();

  // ------------------------------------------------------------ the visitor's device
  // A guess from the user agent. It only orders things: this device's choice goes first in the Download menu
  // (marked "This device"), its card in "Get it on every device" gets the gradient edge, and the [data-for]
  // lines under the hero button follow. Every platform stays one tap away.
  var ua = navigator.userAgent || "";
  var platform =
    /Android/i.test(ua) ? "android" :
    /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? "ios" :
    /Windows/i.test(ua) && !/Windows Phone/i.test(ua) ? "windows" :
    /Linux|Macintosh|CrOS|X11/i.test(ua) ? "other" : "android";
  document.querySelectorAll("[data-for]").forEach(function (el) { el.hidden = el.getAttribute("data-for") !== platform; });
  var mine = document.querySelector('.plat[data-plat="' + platform + '"]');
  if (mine) mine.classList.add("mine");

  // The hero badge for this device (Android, Windows, iPhone, or Browser for everything else) stands out.
  var myBadge = document.querySelector('.plat-link[data-plat="' + platform + '"]');
  if (myBadge) myBadge.classList.add("mine");

  // The floating Menu / Download bar stays out of the way while the hero (with its own badges and Play button)
  // is on screen, and slides in once it is scrolled past.
  (function dockAway() {
    var dock = document.querySelector(".dock");
    var hero = document.querySelector(".hero");
    if (!dock || !hero || !("IntersectionObserver" in window)) return;
    new IntersectionObserver(function (entries) {
      dock.classList.toggle("away", entries[0].isIntersecting);
    }).observe(hero);
  })();

  // ------------------------------------------------------------ hero gameplay loop
  // The hero's still frame is already on screen; 1.5 s after the page has loaded, a 3-second muted loop (465 KB, or
  // 207 KB on narrow screens) fades in over it. Skipped for reduced motion, Data Saver and 2G, and paused
  // whenever the hero is scrolled out of view.
  (function heroVideo() {
    var v = document.getElementById("hero-video");
    if (!v || reduce) return;
    var c = navigator.connection || {};
    if (c.saveData || /(^|-)2g$/.test(c.effectiveType || "")) return;
    var visible = true;
    function play() { var p = v.play(); if (p && p.catch) p.catch(function () {}); }
    function start() {
      v.src = window.innerWidth < 760 ? v.getAttribute("data-src-480") : v.getAttribute("data-src-720");
      v.addEventListener("playing", function () { v.classList.add("on"); }, { once: true });
      if (visible) play();
    }
    if ("IntersectionObserver" in window) {
      new IntersectionObserver(function (entries) {
        visible = entries[0].isIntersecting;
        if (!v.src) return;
        if (visible) play(); else v.pause();
      }).observe(v);
    }
    // Well after the first paint and when the browser is idle, so the loop never competes with the page's
    // own files on a slow connection.
    function later() {
      setTimeout(function () {
        if (window.requestIdleCallback) window.requestIdleCallback(start, { timeout: 1500 });
        else start();
      }, 1500);
    }
    if (document.readyState === "complete") later();
    else window.addEventListener("load", later);
  })();

  // ------------------------------------------------------------ Download menu
  // The hero button opens a menu of every platform instead of starting a download. Without this script it
  // is a plain link to #download.
  (function downloadMenu() {
    var btn = document.getElementById("hero-dl");
    var menu = document.getElementById("dl-menu");
    if (!btn || !menu) return;
    var first = menu.querySelector('.dl-item[data-plat="' + platform + '"]');
    if (first) {
      menu.insertBefore(first, menu.firstChild);
      first.classList.add("mine");
      var tag = document.createElement("em");
      tag.className = "dl-tag";
      tag.textContent = "This device";
      first.querySelector("strong").appendChild(tag);
      // On Windows the portable .exe follows the installer.
      var portable = platform === "windows" && menu.querySelector('.dl-item[data-plat="windows-portable"]');
      if (portable) menu.insertBefore(portable, first.nextSibling);
    }
    var items = function () { return Array.prototype.slice.call(menu.querySelectorAll("[role=menuitem]")); };
    function open(focusFirst) {
      menu.hidden = false;
      btn.setAttribute("aria-expanded", "true");
      // Keep the whole menu above the floating Menu / Download bar at the bottom of the screen.
      var dock = document.querySelector(".dock");
      var limit = window.innerHeight - (dock ? dock.offsetHeight : 0) - 8;
      var over = menu.getBoundingClientRect().bottom - limit;
      if (over > 0) window.scrollBy({ top: over, behavior: reduce ? "auto" : "smooth" });
      if (focusFirst) items()[0].focus({ preventScroll: over > 0 });
    }
    function close(refocus) {
      if (menu.hidden) return;
      menu.hidden = true;
      btn.setAttribute("aria-expanded", "false");
      if (refocus) btn.focus();
    }
    btn.addEventListener("click", function (e) {
      e.preventDefault();
      if (menu.hidden) open(e.detail === 0); else close(false);
    });
    btn.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown") { e.preventDefault(); open(true); }
    });
    menu.addEventListener("keydown", function (e) {
      var list = items(), i = list.indexOf(document.activeElement);
      if (e.key === "Escape") { e.preventDefault(); close(true); }
      else if (e.key === "ArrowDown") { e.preventDefault(); list[(i + 1) % list.length].focus(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); list[(i - 1 + list.length) % list.length].focus(); }
      else if (e.key === "Home") { e.preventDefault(); list[0].focus(); }
      else if (e.key === "End") { e.preventDefault(); list[list.length - 1].focus(); }
      else if (e.key === "Tab") close(false);
    });
    // A choice closes it (a download starts, or the page moves to #download or play/).
    menu.addEventListener("click", function (e) { if (e.target.closest("a")) close(false); });
    document.addEventListener("click", function (e) {
      if (!menu.hidden && !menu.contains(e.target) && !btn.contains(e.target)) close(false);
    });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") close(true); });
    // Phone browsers keep a page in memory when you leave it (back-forward cache, a restored tab): never
    // bring it back with the menu still open.
    window.addEventListener("pagehide", function () { close(false); });
    window.addEventListener("pageshow", function () { close(false); });
  })();

  // No browser "Install app" banner on the website either: the downloads are the apps.
  window.addEventListener("beforeinstallprompt", function (e) { e.preventDefault(); });

  // Release version and file sizes: filled in when the site is built (scripts/build-site.mjs), so visitors'
  // browsers never contact the release host.

  // ------------------------------------------------------------ card deck
  var deck = document.getElementById("deck");
  var cards = Array.prototype.slice.call(deck.querySelectorAll(".card"));
  var dotsEl = document.getElementById("dots");
  var live = document.getElementById("deck-live");
  var order = cards.map(function (_, i) { return i; });
  var busy = false;

  function burst(n, r1, r2) {
    var d = "";
    for (var i = 0; i < n * 2; i++) {
      var r = i % 2 ? r2 : r1, a = Math.PI * i / n;
      d += (i ? "L" : "M") + (64 + r * Math.cos(a)).toFixed(1) + " " + (64 + r * Math.sin(a)).toFixed(1);
    }
    return d + "Z";
  }
  function scallop(n, r, b) {
    var d = "";
    for (var i = 0; i <= 120; i++) {
      var a = Math.PI * 2 * i / 120, rr = r + b * Math.cos(a * n);
      d += (i ? "L" : "M") + (64 + rr * Math.cos(a)).toFixed(1) + " " + (64 + rr * Math.sin(a)).toFixed(1);
    }
    return d + "Z";
  }
  // Paths in a 128 x 128 box. "blocks" echoes the app icon: three skewed road blocks.
  var shapes = {
    burst: [burst(12, 62, 42)],
    scallop: [scallop(9, 50, 9)],
    blob: ["M64 6c22 0 48 14 54 40s-6 50-30 64-56 10-72-10S2 50 14 30 42 6 64 6Z"],
    chevron: ["M20 14h40l40 50-40 50H20l40-50Z", "M70 14h22l34 50-34 50H70l34-50Z"],
    blocks: ["M22 26h26l-5 24H17Z", "M56 26h26l-5 24H51Z", "M90 26h26l-5 24H85Z", "M14 62h112l-7 22H7Z"]
  };
  cards.forEach(function (c) {
    var svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("viewBox", "0 0 128 128");
    svg.setAttribute("class", "sticker");
    svg.setAttribute("aria-hidden", "true");
    (shapes[c.getAttribute("data-shape")] || shapes.burst).forEach(function (d) {
      var p = document.createElementNS(SVGNS, "path");
      p.setAttribute("d", d);
      if (c.getAttribute("data-shape") === "blocks" || c.getAttribute("data-shape") === "chevron") p.setAttribute("stroke-linejoin", "round");
      svg.appendChild(p);
    });
    c.insertBefore(svg, c.firstChild);
  });

  cards.forEach(function (c, i) {
    var b = document.createElement("button");
    b.type = "button";
    b.setAttribute("aria-label", "Card " + (i + 1) + " of " + cards.length + ": " + c.querySelector("h2").textContent);
    b.addEventListener("click", function () { goTo(i); });
    dotsEl.appendChild(b);
  });

  function render() {
    order.forEach(function (ci, pos) {
      var c = cards[ci], p = Math.min(pos, 3);
      c.style.zIndex = String(cards.length - pos);
      c.style.transform = "translateY(" + (p * 9) + "px) scale(" + (1 - p * 0.045) + ")";
      c.style.opacity = pos > 3 ? "0" : "1";
      c.setAttribute("aria-hidden", pos === 0 ? "false" : "true");
      c.inert = pos !== 0;
    });
    var top = order[0];
    Array.prototype.forEach.call(dotsEl.children, function (d, i) { d.setAttribute("aria-current", i === top ? "true" : "false"); });
    live.textContent = "Card " + (top + 1) + " of " + cards.length + ": " + cards[top].querySelector("h2").textContent;
  }
  function next(dir) {
    if (busy) return;
    var top = cards[order[0]];
    if (reduce) { order.push(order.shift()); render(); return; }
    busy = true;
    var left = dir !== 1;
    top.style.transform = "translateX(" + (left ? "-115%" : "115%") + ") rotate(" + (left ? -10 : 10) + "deg)";
    top.style.opacity = "0";
    setTimeout(function () {
      order.push(order.shift());
      top.style.transition = "none";
      render();
      top.getBoundingClientRect();
      top.style.transition = "";
      busy = false;
    }, 300);
  }
  function prev() {
    if (busy) return;
    order.unshift(order.pop());
    render();
  }
  function goTo(i) {
    while (order[0] !== i) order.push(order.shift());
    render();
  }

  // Tap anywhere on the card (not its Open link) or swipe it away.
  var startX = null, startY = 0, dx = 0, pid = null;
  deck.addEventListener("pointerdown", function (e) {
    if (e.target.closest("a") || (e.pointerType === "mouse" && e.button !== 0)) return;
    startX = e.clientX; startY = e.clientY; dx = 0; pid = e.pointerId;
    cards[order[0]].style.transition = "none";
  });
  deck.addEventListener("pointermove", function (e) {
    if (startX === null || e.pointerId !== pid) return;
    dx = e.clientX - startX;
    if (Math.abs(dx) > 4) {
      if (deck.setPointerCapture) try { deck.setPointerCapture(pid); } catch (err) {}
      cards[order[0]].style.transform = "translateX(" + dx + "px) rotate(" + (dx / 24) + "deg)";
    }
  });
  function release(e) {
    if (startX === null) return;
    var top = cards[order[0]];
    top.style.transition = "";
    var dy = e ? Math.abs(e.clientY - startY) : 0;
    startX = null;
    if (Math.abs(dx) > 70) next(dx > 0 ? 1 : -1);
    else if (Math.abs(dx) <= 4 && dy <= 8) next(-1);
    else render();
  }
  deck.addEventListener("pointerup", release);
  deck.addEventListener("pointercancel", function () { startX = null; cards[order[0]].style.transition = ""; render(); });
  deck.addEventListener("keydown", function (e) {
    if (e.key === "ArrowRight") { e.preventDefault(); next(1); }
    if (e.key === "ArrowLeft") { e.preventDefault(); prev(); }
  });
  render();

  // ------------------------------------------------------------ menu
  var menu = document.getElementById("menu");
  var opener = document.getElementById("menu-open");
  if (menu && typeof menu.showModal === "function") {
    opener.addEventListener("click", function () { menu.showModal(); });
    menu.addEventListener("click", function (e) { if (e.target === menu || e.target.closest("a")) menu.close(); });
  } else if (opener) {
    opener.addEventListener("click", function () { location.hash = "#why"; });
  }

  // ------------------------------------------------------------ trailer
  // Nothing but the poster loads with the page. Play swaps in a <video> that streams video/master.m3u8 in
  // 2-second segments, at 480p, 720p or 1080p as the connection allows: natively in Safari (iPhone, iPad, Mac),
  // through hls.js elsewhere (vendor/, fetched on this press only), or the 720p MP4 when neither works.
  var tBox = document.getElementById("trailer-box");
  var tPlay = document.getElementById("trailer-play");
  if (tBox && tPlay) {
    var HLS = "video/master.m3u8";
    var MP4 = "video/trailer-720p.mp4";
    var start = function () {
      if (tBox.classList.contains("loading")) return;
      tBox.classList.add("loading");
      var v = document.createElement("video");
      v.controls = true;
      v.playsInline = true;
      v.preload = "auto";
      v.poster = "video/poster.jpg";
      v.setAttribute("aria-label", "Velocity Blocks trailer");
      var go = function () {
        tBox.replaceChildren(v);
        tBox.classList.remove("loading");
        var p = v.play();
        if (p && p.catch) p.catch(function () {});
      };
      var mp4 = function () { v.src = MP4; go(); };
      if (v.canPlayType("application/vnd.apple.mpegurl")) { v.src = HLS; go(); return; }
      if (!("MediaSource" in window || "ManagedMediaSource" in window)) { mp4(); return; }
      var s = document.createElement("script");
      s.src = "vendor/hls.light.min.js";
      s.onload = function () {
        if (!window.Hls || !window.Hls.isSupported()) { mp4(); return; }
        // Start at 720p on a fast enough link instead of crawling up from 480p, and keep only about 6 s
        // (three segments) ahead, so a visitor who stops early never downloads the rest.
        var hls = new window.Hls({
          capLevelToPlayerSize: true, startLevel: -1, abrEwmaDefaultEstimate: 3000000,
          maxBufferLength: 6, maxMaxBufferLength: 8, maxBufferSize: 0,
        });
        hls.on(window.Hls.Events.ERROR, function (e, d) {
          if (d.fatal) { hls.destroy(); v.removeAttribute("src"); mp4(); }
        });
        hls.loadSource(HLS);
        hls.attachMedia(v);
        go();
      };
      s.onerror = mp4;
      document.head.appendChild(s);
    };
    tPlay.addEventListener("click", start);
  }

  // ------------------------------------------------------------ reveal on scroll
  var reveal = document.querySelectorAll("[data-reveal]");
  if (!reduce && "IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); } });
    }, { rootMargin: "0px 0px -8% 0px" });
    reveal.forEach(function (el) { io.observe(el); });
    // A jump to an anchor shows its section at once.
    window.addEventListener("hashchange", function () {
      var t = location.hash && document.getElementById(location.hash.slice(1));
      if (t) { var r = t.closest("[data-reveal]") || t; r.classList.add("in"); t.querySelectorAll("[data-reveal]").forEach(function (x) { x.classList.add("in"); }); }
    });
  } else {
    reveal.forEach(function (el) { el.classList.add("in"); });
  }
})();
