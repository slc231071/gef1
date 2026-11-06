"use strict";

// Student profile page: knowledge portrait, mastery bars, practice timeline
// and AI personalized practice.
(function () {
  const summaryEl = document.getElementById("profile-summary");
  const topicsEl = document.getElementById("topic-bars");
  const topicsCount = document.getElementById("topics-count");
  const timelineEl = document.getElementById("profile-timeline");
  const personalBtn = document.getElementById("personal-practice");
  const resetBtn = document.getElementById("profile-reset");
  const practicePanel = document.getElementById("personal-practice-panel");
  const practiceIntro = document.getElementById("personal-practice-intro");
  const reportEl = document.getElementById("profile-practice-report");
  const questionsEl = document.getElementById("profile-practice-questions");

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function chip(text, className) {
    return el("span", "chip " + className, text);
  }

  // Mastery heuristic: strong points are mastered; weak points fade with
  // recurrence (each occurrence lowers mastery, floor 20%).
  function masteryOf(topic, weakMap, strongSet) {
    if (strongSet.has(topic)) return 90;
    const count = weakMap.get(topic) || 0;
    return Math.max(20, 100 - count * 20);
  }

  function statCard(value, label, className) {
    const card = el("div", "profile-stat " + (className || ""));
    card.appendChild(el("div", "profile-stat-value", value));
    card.appendChild(el("div", "profile-stat-label", label));
    return card;
  }

  function renderSummary(profile) {
    summaryEl.replaceChildren();
    const history = profile.history || [];
    const weak = (profile.weak_points || []).length;
    const strong = (profile.strong_points || []).length;
    const accuracies = history
      .map(function (h) { return Number(h.accuracy) || 0; })
      .filter(function (a) { return a > 0; });
    const avg = accuracies.length
      ? Math.round((accuracies.reduce(function (a, b) { return a + b; }, 0) / accuracies.length) * 100)
      : null;
    summaryEl.append(
      statCard(String(history.length), "累计练习", "stat-blue"),
      statCard(avg == null ? "—" : avg + "%", "平均正确率", "stat-green"),
      statCard(String(weak), "待攻克弱项", "stat-red"),
      statCard(String(strong), "已掌握强项", "stat-green")
    );
  }

  function renderTopics(profile) {
    topicsEl.replaceChildren();
    const weakMap = new Map();
    (profile.weak_points || []).forEach(function (item) {
      const topic = typeof item === "string" ? item : item.topic;
      const count = (typeof item === "object" && item.count) || 1;
      weakMap.set(topic, count);
    });
    const strongSet = new Set(profile.strong_points || []);
    const topics = Array.from(new Set(
      Array.from(weakMap.keys()).concat(Array.from(strongSet))));
    topicsCount.textContent = topics.length ? topics.length + " 个知识点" : "";
    if (!topics.length) {
      topicsEl.appendChild(el("p", "muted",
        "还没有知识点画像。完成一次作业的 AI 巩固练习后，这里会自动生成你的强弱项图谱。"));
      return;
    }
    topics.sort(function (a, b) {
      return masteryOf(b, weakMap, strongSet) - masteryOf(a, weakMap, strongSet);
    });
    topics.forEach(function (topic) {
      const mastery = masteryOf(topic, weakMap, strongSet);
      const level = mastery >= 70 ? "good" : mastery >= 40 ? "mid" : "bad";
      const row = el("div", "topic-row");
      const head = el("div", "topic-row-head");
      head.appendChild(el("span", "topic-name", topic));
      head.appendChild(el("span", "topic-score " + level, mastery + "%"));
      row.appendChild(head);
      const track = el("div", "topic-track");
      const fill = el("div", "topic-fill " + level);
      fill.style.width = mastery + "%";
      track.appendChild(fill);
      row.appendChild(track);
      row.appendChild(weakMap.has(topic)
        ? chip("弱项 ×" + weakMap.get(topic), "chip-weak")
        : chip("强项", "chip-strong"));
      topicsEl.appendChild(row);
    });
  }

  function renderTimeline(profile) {
    timelineEl.replaceChildren();
    const history = (profile.history || []).slice().reverse();
    if (!history.length) {
      timelineEl.appendChild(el("p", "muted", "暂无练习记录。"));
      return;
    }
    const list = el("ol", "timeline");
    history.slice(0, 10).forEach(function (entry) {
      const item = el("li", "timeline-item");
      const accuracy = Math.round((Number(entry.accuracy) || 0) * 100);
      const dot = el("span", "timeline-dot " +
        (accuracy >= 70 ? "good" : accuracy >= 40 ? "mid" : "bad"));
      const body = el("div", "timeline-body");
      body.appendChild(el("div", "timeline-date", String(entry.date || "").slice(0, 10)));
      body.appendChild(el("div", "timeline-title",
        (entry.title || "AI 练习") + " · 正确率 " + accuracy + "%"));
      if ((entry.weak || []).length) {
        const chips = el("div", "profile-chips");
        entry.weak.forEach(function (topic) { chips.appendChild(chip(topic, "chip-weak")); });
        body.appendChild(chips);
      }
      item.append(dot, body);
      list.appendChild(item);
    });
    timelineEl.appendChild(list);
  }

  function renderAll(profile) {
    renderSummary(profile);
    renderTopics(profile);
    renderTimeline(profile);
  }

  async function load() {
    try {
      const data = await App.api("/api/profile");
      renderAll(data.profile || {});
    } catch (error) {
      summaryEl.replaceChildren();
      summaryEl.appendChild(el("p", "muted", error.message));
    }
  }

  personalBtn.addEventListener("click", async function () {
    personalBtn.disabled = true;
    const original = personalBtn.textContent;
    personalBtn.textContent = "🤖 AI 正在根据你的档案出题…";
    practicePanel.hidden = false;
    practiceIntro.textContent =
      "本组练习由 AI 根据你的历史弱项（按出现次数加权）与强项巩固定制。";
    reportEl.replaceChildren();
    questionsEl.replaceChildren();
    try {
      const payload = await App.apiJson("/api/profile/practice/generate", "POST", {});
      window.PracticeUI.render(reportEl, questionsEl, payload.practice, {
        onSubmitted: load,
      });
      App.showToast("个性化练习已生成，主攻你的薄弱知识点！");
      personalBtn.textContent = "🔄 再来一组";
    } catch (error) {
      App.showToast(error.message, "error");
      practicePanel.hidden = true;
    } finally {
      personalBtn.disabled = false;
      if (personalBtn.textContent.indexOf("再来一组") === -1) {
        personalBtn.textContent = original;
      }
    }
  });

  resetBtn.addEventListener("click", async function () {
    const ok = await App.confirmDialog({
      title: "清除学习档案",
      message: "确定清除全部学习档案吗？强弱项画像和练习记录会被清空，" +
        "之后生成的练习将不再参考历史数据。此操作不可恢复。",
      confirmText: "确认清除",
      cancelText: "暂不清除",
    });
    if (!ok) return;
    resetBtn.disabled = true;
    try {
      await App.api("/api/profile", { method: "DELETE" });
      practicePanel.hidden = true;
      reportEl.replaceChildren();
      questionsEl.replaceChildren();
      renderAll({});
      App.showToast("学习档案已清除。");
    } catch (error) {
      App.showToast(error.message, "error");
    } finally {
      resetBtn.disabled = false;
    }
  });

  load();
})();
