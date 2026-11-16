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
  const ASK_DELAY_MS = 4000;
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
      if (OneSignal.Notifications.permission !== true) {
        setTimeout(() => withOneSignal(os => os.Slidedown.promptPush()), ASK_DELAY_MS);
      }
    });
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
