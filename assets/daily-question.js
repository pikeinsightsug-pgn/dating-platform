// Question of the Day (supabase/daily_question.sql), shown at the top of Discover Members.
// 1. Every approved member sees the same light question each day.
// 2. They answer in a few words; only then can they see how others answered.
// 3. Each answer has a Message button, so a fun answer turns straight into a conversation.
// Nothing here blocks the page: if the database setup is missing, the card simply stays hidden.
(function (root) {
  "use strict";
  const MAX = 150;
  let busy = false;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function avatar(row, url) {
    if (url) {
      const image = el("img", "dq-avatar");
      image.src = url; image.alt = ""; image.loading = "lazy";
      image.addEventListener("error", () => image.replaceWith(avatar(row, null)), { once: true });
      return image;
    }
    const blank = el("span", "dq-avatar", "❤️");
    blank.setAttribute("aria-hidden", "true");
    return blank;
  }

  async function renderAnswers(db, list) {
    const { data, error } = await db.rpc("todays_answers", { p_limit: 30 });
    if (error) { list.replaceChildren(el("p", "dq-note", "Other answers could not be loaded. Reload the page to try again.")); return; }
    const rows = data || [];
    if (!rows.length) {
      list.replaceChildren(el("p", "dq-note", "You are the first to answer today 🎉 Check back later to see what others said."));
      return;
    }
    const urls = window.FYP && window.FYP.signedPhotoUrls
      ? await window.FYP.signedPhotoUrls(db, rows.map(r => r.profile_photo_path).filter(Boolean)).catch(() => new Map())
      : new Map();
    list.replaceChildren(...rows.map(row => {
      const item = el("article", "dq-answer" + (row.is_official ? " dq-official" : ""));
      item.append(avatar(row, row.profile_photo_path ? urls.get(row.profile_photo_path) : null));
      const body = el("div", "dq-body");
      const who = row.is_official
        ? row.first_name + " ✅"
        : row.first_name + ", " + row.age + " · " + [row.city, row.location].filter(Boolean).join(", ");
      body.append(el("p", "dq-who", who), el("p", "dq-text", "“" + row.answer + "”"));
      item.append(body);
      const message = el("a", "btn dq-message", "💬 Reply");
      message.href = "messages.html?member=" + encodeURIComponent(row.member_id);
      message.setAttribute("aria-label", "Message " + row.first_name + " about their answer");
      item.append(message);
      return item;
    }));
  }

  async function render(db) {
    const card = document.getElementById("daily-question");
    if (!card || !db) return;
    let row;
    try {
      const { data, error } = await db.rpc("todays_question");
      row = Array.isArray(data) ? data[0] : data;
      if (error || !row || !row.question) return; // not installed yet, or not approved: stay hidden
    } catch (error) { return; }

    const $ = id => document.getElementById(id);
    const form = $("dq-form"), input = $("dq-input"), save = $("dq-save"), status = $("dq-status");
    const mine = $("dq-mine"), list = $("dq-answers"), count = $("dq-count");
    $("dq-question").textContent = row.question;
    input.maxLength = MAX;

    function showCount(n) {
      count.textContent = n ? n + (n === 1 ? " member answered" : " members answered") : "Be the first to answer";
    }
    function showAnswered(answer) {
      form.classList.add("hidden");
      mine.classList.remove("hidden");
      $("dq-mine-text").textContent = "“" + answer + "”";
      list.classList.remove("hidden");
      renderAnswers(db, list).catch(() => {});
    }
    showCount(Number(row.answer_count) || 0);
    if (row.my_answer) showAnswered(row.my_answer);
    else { form.classList.remove("hidden"); mine.classList.add("hidden"); list.classList.add("hidden"); }

    $("dq-edit").onclick = () => {
      input.value = row.my_answer || "";
      mine.classList.add("hidden"); list.classList.add("hidden");
      form.classList.remove("hidden"); input.focus();
    };
    form.onsubmit = async event => {
      event.preventDefault();
      const answer = input.value.replace(/\s+/g, " ").trim();
      if (busy) return;
      if (!answer) { status.textContent = "Write a few words first."; return; }
      busy = true; save.disabled = true; status.textContent = "Saving your answer…";
      try {
        const { error } = await db.rpc("answer_daily_question", { p_answer: answer.slice(0, MAX) });
        if (error) throw error;
        const first = !row.my_answer;
        row.my_answer = answer.slice(0, MAX);
        if (first) { row.answer_count = (Number(row.answer_count) || 0) + 1; showCount(row.answer_count); }
        status.textContent = "";
        input.value = "";
        showAnswered(row.my_answer);
      } catch (error) {
        status.textContent = "Your answer could not be saved. Check your connection and try again.";
      } finally { busy = false; save.disabled = false; }
    };
    card.classList.remove("hidden");
  }

  root.FYPDailyQuestion = { render };
})(typeof window !== "undefined" ? window : globalThis);
