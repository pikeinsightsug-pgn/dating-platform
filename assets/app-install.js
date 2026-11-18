// Makes P.K CONNECT installable as a phone app and shows an "Install the app" button where a
// page has one (id="install-app"). On the member pages (dashboard, discover, messages) it also
// pops up, by itself, a short card telling members on a phone how to pin P.K CONNECT to their
// home screen, with the right steps for Android or iPhone. "Maybe later" hides it for 2 days,
// "Done" for 30 days, and it never shows once the app is installed or on a computer.
(function () {
  "use strict";
  const secure = location.protocol === "https:" || location.hostname === "127.0.0.1" || location.hostname === "localhost";
  if ("serviceWorker" in navigator && secure) {
    navigator.serviceWorker.register("sw.js").catch(() => { /* the website works without it */ });
  }
  const installed = window.matchMedia && window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  if (installed) return;

  const ua = navigator.userAgent || "";
  const ios = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const android = /android/i.test(ua);
  // Facebook, Instagram, WhatsApp and similar open links in their own small browser, which
  // cannot pin a website. Members must open the page in Chrome or Safari first.
  const inAppBrowser = /FBAN|FBAV|FB_IAB|Instagram|WhatsApp|Line\/|Snapchat|TikTok|musical_ly/i.test(ua);

  let prompt = null;
  const listeners = [];
  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault(); prompt = event;
    listeners.forEach(fn => fn());
  });
  async function askPhoneToInstall() {
    if (!prompt) return false;
    const current = prompt; prompt = null;
    current.prompt();
    try { const choice = await current.userChoice; return !!choice && choice.outcome === "accepted"; } catch (error) { return false; }
  }

  // Home page banner (unchanged behaviour).
  const box = document.getElementById("install-app");
  if (box) {
    const button = box.querySelector("button");
    const tip = box.querySelector("[data-install-tip]");
    listeners.push(() => { box.hidden = false; button.hidden = false; if (tip) tip.hidden = true; });
    button.addEventListener("click", async () => { await askPhoneToInstall(); box.hidden = true; });
    window.addEventListener("appinstalled", () => { box.hidden = true; });
    // iPhone and iPad (Safari) have no install button; show how to add it instead.
    if (ios && tip) { box.hidden = false; button.hidden = true; tip.hidden = false; }
    return;
  }

  // Automatic "pin the app" pop-up on the member pages, phones and tablets only.
  const page = (location.pathname.split("/").pop() || "").toLowerCase();
  if (!["dashboard.html", "discover.html", "messages.html"].includes(page)) return;
  if (!ios && !android) return;

  const KEY = "pk-pin-popup-until";
  const DAY = 24 * 60 * 60 * 1000;
  function hiddenUntil() { try { return Number(localStorage.getItem(KEY)) || 0; } catch (error) { return 0; } }
  function hideFor(days) { try { localStorage.setItem(KEY, String(Date.now() + days * DAY)); } catch (error) { /* shown again next visit */ } }
  if (hiddenUntil() > Date.now()) return;

  const STYLE = `
.pkpin{position:fixed;left:0;right:0;bottom:0;z-index:1000;display:flex;justify-content:center;padding:0 10px calc(10px + env(safe-area-inset-bottom));animation:pkpin-up .35s ease-out}
.pkpin-card{width:100%;max-width:460px;background:#fff;color:#241b23;border-radius:22px;box-shadow:0 -6px 40px #5c183040;border:1px solid #f0dfe7;padding:18px 18px 16px;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;line-height:1.45}
.pkpin-head{display:flex;gap:12px;align-items:center;margin-bottom:10px}
.pkpin-head img{width:52px;height:52px;border-radius:14px;flex:none}
.pkpin-head h2{margin:0;font-size:18px;line-height:1.2}
.pkpin-head p{margin:2px 0 0;color:#6a5b64;font-size:14px}
.pkpin-x{margin-left:auto;align-self:flex-start;background:none;border:0;font-size:24px;line-height:1;color:#6a5b64;padding:2px 6px;cursor:pointer}
.pkpin ol{margin:6px 0 12px;padding-left:22px;font-size:15px}
.pkpin li{margin:5px 0}
.pkpin .pkpin-note{background:#fff4f8;border:1px solid #f0dfe7;border-radius:12px;padding:9px 11px;font-size:14px;margin:0 0 12px}
.pkpin-actions{display:flex;gap:8px;flex-wrap:wrap}
.pkpin-actions button{flex:1 1 140px;border-radius:999px;font-weight:800;font-size:15px;padding:12px 14px;cursor:pointer;border:2px solid #b32663}
.pkpin-main{background:#b32663;color:#fff}
.pkpin-later{background:#fff;color:#b32663}
@keyframes pkpin-up{from{transform:translateY(100%);opacity:0}to{transform:none;opacity:1}}
@media (prefers-reduced-motion:reduce){.pkpin{animation:none}}`;

  function steps() {
    if (inAppBrowser) {
      return {
        note: "⚠️ You opened P.K CONNECT inside another app (WhatsApp, Facebook…). It can only be pinned from " + (ios ? "Safari" : "Chrome") + ".",
        list: ios
          ? ["Tap <b>•••</b> or the <b>Share ⬆️</b> button in this window", "Choose <b>Open in Safari</b>", "In Safari, tap <b>Share ⬆️</b> → <b>Add to Home Screen</b> → <b>Add</b>"]
          : ["Tap the <b>⋮</b> (3 dots) at the top right of this window", "Choose <b>Open in Chrome</b>", "In Chrome, tap <b>⋮</b> → <b>Add to Home screen</b> (or <b>Install app</b>) → <b>Add</b>"]
      };
    }
    if (ios) {
      return { list: ["Tap the <b>Share</b> button <b>⬆️</b> (bottom of Safari, or top right in Chrome)", "Scroll down and tap <b>Add to Home Screen ➕</b>", "Tap <b>Add</b> at the top right"] };
    }
    if (prompt) return { install: true, list: ["Tap <b>Install now</b> below", "Tap <b>Install</b> when your phone asks"] };
    return { list: ["Tap the <b>⋮</b> (3 dots) at the top right of Chrome", "Tap <b>Add to Home screen</b> (or <b>Install app</b>)", "Tap <b>Add</b>"] };
  }

  let sheet = null;
  function close(days) { if (sheet) { sheet.remove(); sheet = null; } if (days) hideFor(days); }

  function render() {
    const s = steps();
    sheet.querySelector("ol").innerHTML = s.list.map(item => "<li>" + item + "</li>").join("");
    const note = sheet.querySelector(".pkpin-note");
    note.hidden = !s.note; note.textContent = s.note || "";
    const main = sheet.querySelector(".pkpin-main");
    main.textContent = s.install ? "📲 Install now" : "✅ Done";
    main.dataset.install = s.install ? "1" : "";
  }

  function show() {
    if (sheet || hiddenUntil() > Date.now()) return;
    if (!document.getElementById("pkpin-style")) {
      const style = document.createElement("style"); style.id = "pkpin-style"; style.textContent = STYLE;
      document.head.appendChild(style);
    }
    sheet = document.createElement("div");
    sheet.className = "pkpin"; sheet.id = "pin-app-popup";
    sheet.setAttribute("role", "dialog"); sheet.setAttribute("aria-labelledby", "pkpin-title");
    sheet.innerHTML =
      '<div class="pkpin-card">' +
        '<div class="pkpin-head"><img src="assets/app/icon-192.png" alt="" width="52" height="52">' +
          '<div><h2 id="pkpin-title">📲 Pin P.K CONNECT to your phone</h2><p>Open your matches in one tap, like an app. Free, no app store.</p></div>' +
          '<button type="button" class="pkpin-x" aria-label="Close">×</button></div>' +
        '<p class="pkpin-note" hidden></p><ol></ol>' +
        '<div class="pkpin-actions"><button type="button" class="pkpin-main"></button><button type="button" class="pkpin-later">Maybe later</button></div>' +
      '</div>';
    render();
    sheet.querySelector(".pkpin-x").addEventListener("click", () => close(2));
    sheet.querySelector(".pkpin-later").addEventListener("click", () => close(2));
    sheet.querySelector(".pkpin-main").addEventListener("click", async event => {
      if (event.currentTarget.dataset.install) {
        const accepted = await askPhoneToInstall();
        if (accepted) close(30); else render();
        return;
      }
      close(30);
    });
    document.body.appendChild(sheet);
  }

  listeners.push(() => { if (sheet) render(); });
  window.addEventListener("appinstalled", () => close(365));
  // Give the page a moment to load first so the pop-up does not cover it straight away.
  const start = () => setTimeout(show, 4000);
  if (document.readyState === "complete") start(); else window.addEventListener("load", start);
})();
