// Invite-a-friend links (supabase/invites.sql).
// 1. On any page, a link such as pkconnectonline.com/?invite=ab12cd34 is remembered on this
//    browser for 30 days.
// 2. Once the visitor has joined and is signed in, the code is claimed once, so the inviter's
//    "friends joined" count goes up. A wrong, old or own code is simply ignored.
// 3. The dashboard shows each member their own link with Copy and Share buttons.
// Nothing here blocks the page: if storage or the database is unavailable it quietly does nothing.
(function (root) {
  "use strict";
  const KEY = "pk_invite";
  const KEEP_MS = 30 * 24 * 60 * 60 * 1000;
  const SITE = "https://pkconnectonline.com/";
  const valid = code => typeof code === "string" && /^[a-z0-9]{6,12}$/.test(code);

  function read() {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) || "null");
      if (saved && valid(saved.code) && Date.now() - saved.at < KEEP_MS) return saved.code;
      localStorage.removeItem(KEY);
    } catch (error) { /* storage unavailable */ }
    return null;
  }

  (function capture() {
    try {
      const code = (new URLSearchParams(location.search).get("invite") || "").trim().toLowerCase();
      if (valid(code)) localStorage.setItem(KEY, JSON.stringify({ code, at: Date.now() }));
    } catch (error) { /* storage unavailable */ }
  })();

  let claiming = false;
  async function claim(db) {
    const code = read();
    if (!code || claiming || !db) return;
    claiming = true;
    try {
      const { error } = await db.rpc("claim_invite", { p_code: code });
      // Claimed, already invited or not a valid code: either way, never try again.
      if (!error) { try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ } }
    } catch (error) { /* try again on a later page */ }
    claiming = false;
  }

  function shareText(link) {
    return "I joined P.K Connect, a dating site for real, serious singles where fake profiles are removed. " +
      "Registration is free: " + link;
  }

  async function render(db) {
    const card = document.getElementById("invite-card");
    if (!card || !db) return;
    try {
      const { data, error } = await db.rpc("my_invite");
      const row = Array.isArray(data) ? data[0] : data;
      if (error || !row || !valid(row.invite_code)) return;
      const link = SITE + "?invite=" + row.invite_code;
      const text = shareText(link);
      const $ = id => document.getElementById(id);
      $("invite-link").value = link;
      $("invite-whatsapp").href = "https://wa.me/?text=" + encodeURIComponent(text);
      $("invite-facebook").href = "https://www.facebook.com/sharer/sharer.php?u=" + encodeURIComponent(link);
      const joined = Number(row.friends_joined) || 0;
      $("invite-count").textContent = joined ? "🎉 " + joined + (joined === 1 ? " friend joined" : " friends joined") : "";
      $("invite-copy").onclick = async () => {
        try { await navigator.clipboard.writeText(link); }
        catch (e) { $("invite-link").select(); try { document.execCommand("copy"); } catch (e2) { /* ignore */ } }
        $("invite-status").textContent = "Link copied. Paste it to a friend.";
      };
      if (navigator.share) {
        $("invite-share").classList.remove("hidden");
        $("invite-share").onclick = () => navigator.share({ title: "P.K Connect", text: text.slice(0, text.lastIndexOf(":")) + ".", url: link }).catch(() => {});
      }
      card.classList.remove("hidden");
    } catch (error) { /* card stays hidden */ }
  }

  root.FYPInvite = { claim, render };
})(typeof window !== "undefined" ? window : globalThis);
