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
  // Android keeps the page as written (the APK). Windows gets the installer, iPhone/iPad and other computers
  // the browser game; the [data-for] lines under the hero button follow. A guess from the user agent: the
  // "Get it on every device" section always lists everything.
  var LATEST = "https://github.com/Mitovoid-AI/VelocityBlocks/releases/latest/download/";
  var ua = navigator.userAgent || "";
  var platform =
    /Android/i.test(ua) ? "android" :
    /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? "ios" :
    /Windows/i.test(ua) && !/Windows Phone/i.test(ua) ? "windows" :
    /Linux|Macintosh|CrOS|X11/i.test(ua) ? "other" : "android";
  var DL = {
    android: { href: LATEST + "VelocityBlocks.apk", label: "Download for Android", short: "Download" },
    windows: { href: LATEST + "VelocityBlocks-Setup.exe", label: "Download for Windows", short: "Download" },
    ios: { href: "play/", label: "Play on iPhone and iPad", short: "Play" },
    other: { href: "play/", label: "Play in your browser", short: "Play" }
  }[platform];
  if (platform !== "android") {
    var heroBtn = document.getElementById("hero-dl");
    var heroLabel = document.getElementById("hero-dl-label");
    if (heroBtn && heroLabel) {
      heroBtn.href = DL.href;
      heroBtn.removeAttribute("data-apk");
      heroLabel.textContent = DL.label;
    }
    document.querySelectorAll("[data-for]").forEach(function (el) { el.hidden = el.getAttribute("data-for") !== platform; });
    document.querySelectorAll("[data-dl]").forEach(function (el) {
      el.href = DL.href;
      el.removeAttribute("data-apk");
      var last = el.lastChild;
      if (last && last.nodeType === 3) last.textContent = DL.short;
    });
  }
  var mine = document.querySelector('.plat[data-plat="' + platform + '"]');
  if (mine) mine.classList.add("mine");

  // ------------------------------------------------------------ release version and file sizes
  // The links always point at releases/latest/download/<fixed name>; this only fills in the version and the
  // [data-asset-size="<file name>"] sizes. Offline, rate-limited (60 requests an hour per IP) or blocked:
  // the static text stays.
  function showRelease(info) {
    if (!info) return;
    var sizes = info.sizes || {};
    document.querySelectorAll("[data-asset-size]").forEach(function (el) {
      var s = sizes[el.getAttribute("data-asset-size")];
      if (s) el.textContent = s;
    });
    if (info.version) document.querySelectorAll("[data-release-version]").forEach(function (el) { el.textContent = " · " + info.version; });
  }
  (function releaseInfo() {
    var KEY = "vb-site-release-info";
    try {
      var cached = JSON.parse(sessionStorage.getItem(KEY) || "null");
      if (cached && Date.now() - cached.at < 3600000) return showRelease(cached);
    } catch (e) {}
    if (!window.fetch) return;
    var ctl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 6000);
    fetch("https://api.github.com/repos/Mitovoid-AI/VelocityBlocks/releases/latest", {
      headers: { Accept: "application/vnd.github+json" },
      signal: ctl ? ctl.signal : undefined
    }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function (rel) {
      var info = { at: Date.now(), sizes: {} };
      ((rel && rel.assets) || []).forEach(function (a) {
        if (a && a.name && a.size) info.sizes[a.name] = (a.size / 1e6 >= 20 ? Math.round(a.size / 1e6) : (a.size / 1e6).toFixed(1)) + " MB";
      });
      if (rel && /^v?\d+\.\d+\.\d+$/.test(rel.tag_name || "")) info.version = "v" + rel.tag_name.replace(/^v/, "");
      showRelease(info);
      try { sessionStorage.setItem(KEY, JSON.stringify(info)); } catch (e) {}
    }).catch(function () {}).then(function () { clearTimeout(timer); });
  })();

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
    b.setAttribute("aria-label", "Card " + (i + 1) + " of " + cards.length + ": " + c.querySelector("h3").textContent);
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
    live.textContent = "Card " + (top + 1) + " of " + cards.length + ": " + cards[top].querySelector("h3").textContent;
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
