// Makes P.K CONNECT installable as a phone app and shows an "Install the app" button where a
// page has one (id="install-app"). It changes nothing else on the page.
(function () {
  "use strict";
  const secure = location.protocol === "https:" || location.hostname === "127.0.0.1" || location.hostname === "localhost";
  if ("serviceWorker" in navigator && secure) {
    navigator.serviceWorker.register("sw.js").catch(() => { /* the website works without it */ });
  }
  const installed = window.matchMedia && window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  const box = document.getElementById("install-app");
  if (!box || installed) return;
  const button = box.querySelector("button");
  const tip = box.querySelector("[data-install-tip]");
  let prompt = null;
  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault(); prompt = event;
    box.hidden = false; button.hidden = false; if (tip) tip.hidden = true;
  });
  button.addEventListener("click", async () => {
    if (!prompt) return;
    prompt.prompt();
    try { await prompt.userChoice; } catch (error) { /* closed */ }
    prompt = null; box.hidden = true;
  });
  window.addEventListener("appinstalled", () => { box.hidden = true; });
  // iPhone and iPad (Safari) have no install button; show how to add it instead.
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (ios && tip) { box.hidden = false; button.hidden = true; tip.hidden = false; }
})();
