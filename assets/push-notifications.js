// Phone pop-up notifications for new messages, through OneSignal (free web push).
// Only approved members who are signed in are asked, and only after their page has loaded,
// so visitors on the landing page are never interrupted. The member's id is linked to their
// browser (OneSignal "external id") so the database can notify exactly that member. Logging
// out unlinks it, so a shared phone never shows someone else's messages.
// If OneSignal cannot load (offline, blocked, unsupported browser) the website works as before.
(function (root) {
  "use strict";
  const APP_ID = "8e44de4a-0ae7-4a62-b9fb-099b24a6b81c";
  const SDK = "https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.page.js";
  const HIDE_KEY = "fyp-alerts-card-hidden-until";
  const DAY = 24 * 60 * 60 * 1000;
  let started = false;

  function supported() {
    const secure = location.protocol === "https:";
    return secure && "serviceWorker" in navigator && "PushManager" in root && "Notification" in root;
  }

  function withOneSignal(task) {
    root.OneSignalDeferred = root.OneSignalDeferred || [];
    root.OneSignalDeferred.push(async function (OneSignal) {
      try { await task(OneSignal); } catch (error) { /* notifications are optional */ }
    });
  }

  function start(profile) {
    if (started || !profile || !profile.id || profile.approved !== true || !supported()) return;
    started = true;
    const script = document.createElement("script");
    script.src = SDK; script.defer = true;
    document.head.append(script);
    withOneSignal(async OneSignal => {
      await OneSignal.init({
        appId: APP_ID,
        serviceWorkerPath: "sw.js",
        serviceWorkerParam: { scope: "/" },
        notifyButton: { enable: false }
      });
      await OneSignal.login(String(profile.id));
      if (OneSignal.Notifications.permission !== true) showAlertsCard(OneSignal);
    });
  }

  // "Turn on message alerts" card on the page instead of OneSignal's automatic pop-up: the
  // pop-up is easy to miss and, once dismissed, stays away for days. The card's button asks the
  // phone directly. Members who blocked alerts get the steps to unblock them, since the phone
  // will not ask again. "Not now" hides the card for 3 days. (iPhones only support alerts once
  // P.K CONNECT is on the Home Screen; app-install.js explains that, so no card is shown there.)
  const CARD_STYLE = `
.alerts-card{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;margin:14px 0;padding:16px 18px;
 border-radius:16px;background:#fff8fb;border:2px solid #f3c6da;color:#3d2433;font-size:16px;line-height:1.45}
.alerts-card p{margin:0;flex:1 1 230px}.alerts-card b{color:#a0124b}
.alerts-card .alerts-actions{display:flex;gap:8px;flex-wrap:wrap}
.alerts-card button{min-height:44px;border-radius:999px;padding:10px 18px;font-weight:800;font-size:15px;cursor:pointer}
.alerts-card .alerts-on{background:#b32663;color:#fff;border:0}.alerts-card .alerts-later{background:#fff;color:#a0124b;border:2px solid #f3c6da}`;
  function hiddenUntil() { try { return Number(root.localStorage.getItem(HIDE_KEY)) || 0; } catch (error) { return 0; } }
  function hideFor(days) { try { root.localStorage.setItem(HIDE_KEY, String(Date.now() + days * DAY)); } catch (error) { /* shown again next visit */ } }
  function phonePermission(OneSignal) {
    const native = OneSignal && OneSignal.Notifications && OneSignal.Notifications.permissionNative;
    if (native === "granted" || native === "denied" || native === "default") return native;
    return root.Notification ? root.Notification.permission : "default";
  }
  function showAlertsCard(OneSignal) {
    if (Date.now() < hiddenUntil() || document.getElementById("alerts-card")) return;
    if (!document.getElementById("alerts-card-style")) {
      const style = document.createElement("style"); style.id = "alerts-card-style"; style.textContent = CARD_STYLE; document.head.append(style);
    }
    const card = document.createElement("section"); card.id = "alerts-card"; card.className = "alerts-card";
    card.setAttribute("aria-label", "Message alerts");
    const text = document.createElement("p");
    const actions = document.createElement("div"); actions.className = "alerts-actions";
    const button = (label, cls, onClick) => {
      const b = document.createElement("button"); b.type = "button"; b.className = cls; b.textContent = label;
      b.addEventListener("click", onClick); return b;
    };
    const later = button("Not now", "alerts-later", () => { hideFor(3); card.remove(); });
    function blocked() {
      text.innerHTML = "🔕 <b>Message alerts are blocked</b> on this browser. To turn them on, tap the <b>🔒</b> (or <b>ⓘ</b>) next to the website address → <b>Permissions</b> or <b>Notifications</b> → <b>Allow</b>, then reload this page.";
      actions.replaceChildren(button("OK", "alerts-later", () => { hideFor(14); card.remove(); }));
    }
    if (phonePermission(OneSignal) === "denied") blocked();
    else {
      text.innerHTML = "🔔 <b>Never miss a message.</b> Get an alert on this phone the moment someone writes to you, even when P.K CONNECT is closed.";
      const on = button("Turn on alerts", "alerts-on", async () => {
        on.disabled = true;
        try { await OneSignal.Notifications.requestPermission(); } catch (error) { /* answered below */ }
        const answer = phonePermission(OneSignal);
        if (answer === "granted") {
          text.innerHTML = "✅ <b>Alerts are on.</b> You'll know the moment someone writes to you.";
          actions.replaceChildren();
          setTimeout(() => card.remove(), 4000);
        } else if (answer === "denied") blocked();
        else on.disabled = false;
      });
      actions.append(on, later);
    }
    card.append(text, actions);
    const anchor = document.getElementById("unread-banner") || document.getElementById("signed-in");
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(card, anchor.nextSibling);
    else document.body.prepend(card);
  }

  // Called just before signing out. Never blocks sign-out for more than 2 seconds.
  function stop() {
    if (!started) return Promise.resolve();
    return Promise.race([
      new Promise(resolve => withOneSignal(async OneSignal => { await OneSignal.logout(); resolve(); })),
      new Promise(resolve => setTimeout(resolve, 2000))
    ]);
  }

  root.FYPPush = { start, stop };
})(typeof window !== "undefined" ? window : globalThis);
