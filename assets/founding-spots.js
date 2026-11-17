// "Only N of 100 free founding spots left", updated automatically from the database.
// It asks Supabase for one number only (supabase/founding_spots.sql). If that number cannot be
// read, or all spots are taken, nothing is shown, so the page never displays a wrong count.
(function () {
  "use strict";
  const URL_ = "https://cyvkpcwjkeifpvegwhpt.supabase.co/rest/v1/rpc/founding_spots_left";
  const KEY = "sb_publishable_vzGFbhe7X3CpobiHZAk9Lw_2V3O-F3V";
  const targets = document.querySelectorAll("[data-founding-spots]");
  if (!targets.length || !window.fetch) return;
  fetch(URL_, { method: "POST", headers: { apikey: KEY, "Content-Type": "application/json" }, body: "{}" })
    .then(response => response.ok ? response.json() : null)
    .then(left => {
      if (typeof left !== "number" || left <= 0 || left > 100) return;
      targets.forEach(el => {
        el.textContent = "🔥 Only " + left + " of 100 free founding-member spots left";
        el.hidden = false;
      });
    })
    .catch(() => {});
})();
