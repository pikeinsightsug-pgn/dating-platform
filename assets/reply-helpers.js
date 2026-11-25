// One-tap message suggestions for Messages. Many first messages get no reply because people do
// not know what to say, so when someone is waiting for an answer (or a conversation has not
// started yet) Messages offers three short, friendly messages. Tapping one only fills the box:
// the member can change it and still has to press Send. Built from what the other member shows
// on their profile (first name, city, interests, profession); never from message text.
(function (root) {
  "use strict";

  // Profile words are used only when they look like plain words: nothing with digits, links,
  // @ or contact apps, so a suggestion can never trip the contact-details filter.
  const UNSAFE = /[0-9@<>]|https?:|www\.|whats\s*app|telegram|instagram|facebook|snapchat|e-?mail|\bphone\b|\bcall\b/i;
  function clean(value, max) {
    const text = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
    if (!text || text.length > max || UNSAFE.test(text)) return "";
    return text;
  }
  function firstInterest(interests) {
    for (const part of String(interests || "").split(/[,;\n/|]+|\band\b/i)) {
      const item = clean(part.replace(/^[^\p{L}]+|[^\p{L})]+$/gu, ""), 30);
      if (item && item.length > 2) return item.toLowerCase();
    }
    return "";
  }

  // "a teacher", "an engineer" ("u" words take "a": "a university lecturer").
  function withArticle(job) { const j = job.toLowerCase(); return (/^[aeio]/.test(j) ? "an " : "a ") + j; }

  // other: { first_name, city, interests, profession }
  // context: { started: did either person send anything yet?, lastFromThem: their message
  //            waiting for an answer, lastBody: that message (only checked for a question mark) }
  function suggestReplies(other = {}, context = {}) {
    const name = clean(other.first_name, 40) || "there";
    const city = clean(other.city, 40);
    const interest = firstInterest(other.interests);
    const profession = clean(other.profession, 40);
    const asked = /\?\s*$/.test(String(context.lastBody || "").trim());

    if (!context.started) {
      const personal = interest ? "Hi " + name + "! I see you enjoy " + interest + ". What got you into it?"
        : profession ? "Hi " + name + "! What do you enjoy most about being " + withArticle(profession) + "?"
        : city ? "Hi " + name + "! What do you enjoy most about life in " + city + "?"
        : "Hi " + name + "! Tell me a little about yourself. What makes you smile? 😊";
      return [
        "Hi " + name + " 👋 I came across your profile and wanted to say hello. How is your day going?",
        personal,
        "Hello " + name + " 😊 What does a perfect first date look like for you?",
      ];
    }
    if (!context.lastFromThem) return [];
    const personal = interest ? "I see you enjoy " + interest + ". What do you love most about it?"
      : profession ? "What do you enjoy most about being " + withArticle(profession) + "?"
      : city ? "How is life in " + city + " these days?"
      : "Tell me a bit more about yourself 😊 What do you enjoy doing at the weekend?";
    return [
      asked ? "Good question, " + name + "! " : "Hi " + name + "! Thanks for your message 😊 How are you today?",
      "Hello " + name + "! It's lovely to hear from you. How is your week going?",
      personal,
    ];
  }

  const api = { suggestReplies };
  root.FYPReplies = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
