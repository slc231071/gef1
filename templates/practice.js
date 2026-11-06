"use strict";

// Shared AI practice UI: renders a report card + an answerable question list.
// Used by the homework page (returned work) and the student profile page.
window.PracticeUI = (function () {
  const TARGET_LABELS = {
    weak: "针对你的弱项",
    current: "本次错题相关",
    strong: "强项巩固",
  };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function renderReport(container, report) {
    container.replaceChildren();
    if (!report || (!report.summary && !(report.weaknesses || []).length)) return;
    const card = el("div", "practice-report");
    if (report.summary) card.appendChild(el("p", "practice-report-summary", report.summary));

    const chips = el("div", "practice-report-chips");
    (report.strengths || []).forEach(function (topic) {
      chips.appendChild(el("span", "chip chip-strong", "💪 强项 · " + topic));
    });
    (report.weaknesses || []).forEach(function (item) {
      chips.appendChild(el("span", "chip chip-weak", "⚠ 弱项 · " + (item.topic || item)));
    });
    if (chips.children.length) card.appendChild(chips);

    if (report.trend) {
      card.appendChild(el("p", "practice-report-trend", "📈 " + report.trend));
    }
    if ((report.advice || []).length) {
      const list = el("ul", "practice-report-advice");
      report.advice.forEach(function (item) {
        list.appendChild(el("li", null, item));
      });
      card.appendChild(list);
    }
    container.appendChild(card);
  }

  function renderQuestions(container, practice, options) {
    container.replaceChildren();
    const questions = practice.questions || [];
    if (!questions.length) return;
    const answers = {};
    let submitted = false;

    questions.forEach(function (question, index) {
      const card = el("div", "practice-question");
      const head = el("div", "practice-question-head");
      head.appendChild(el("span", "practice-question-index", "第 " + (index + 1) + " 题"));
      head.appendChild(el("span", "chip chip-topic", question.topic || "综合"));
      if (question.target && TARGET_LABELS[question.target]) {
        head.appendChild(el("span", "chip chip-target", TARGET_LABELS[question.target]));
      }
      card.appendChild(head);
      card.appendChild(el("p", "practice-question-text", question.question));

      const optionsWrap = el("div", "practice-options");
      (question.options || []).forEach(function (option) {
        const letter = option.slice(0, 1).toUpperCase();
        const button = el("button", "practice-option", option);
        button.type = "button";
        button.addEventListener("click", function () {
          if (submitted) return;
          answers[index] = letter;
          Array.prototype.forEach.call(optionsWrap.children, function (child) {
            child.classList.remove("selected");
          });
          button.classList.add("selected");
        });
        optionsWrap.appendChild(button);
      });
      card.appendChild(optionsWrap);
      const feedback = el("p", "practice-feedback");
      card.appendChild(feedback);
      question.__feedback = feedback;
      question.__optionsWrap = optionsWrap;
      container.appendChild(card);
    });

    const actions = el("div", "practice-actions");
    const submit = el("button", "primary-button", "提交答案");
    submit.type = "button";
    submit.addEventListener("click", async function () {
      if (submitted) return;
      const answered = Object.keys(answers).length;
      if (answered < questions.length) {
        App.showToast("还有 " + (questions.length - answered) + " 题未作答。", "error");
        return;
      }
      submit.disabled = true;
      submit.textContent = "判分中…";
      try {
        const data = await App.apiJson(
          "/api/practice/" + practice.id + "/submit", "POST", { answers: answers });
        submitted = true;
        const result = data.result || {};
        questions.forEach(function (question, index) {
          const given = (answers[index] || "").toUpperCase();
          const expected = (question.answer || "").toUpperCase();
          const ok = given === expected;
          Array.prototype.forEach.call(question.__optionsWrap.children, function (child) {
            const letter = child.textContent.slice(0, 1).toUpperCase();
            if (letter === expected) child.classList.add("correct");
            else if (letter === given && !ok) child.classList.add("wrong");
          });
          question.__feedback.textContent = (ok ? "✅ 正确。" : "❌ 正确答案：" + expected + "。") +
            (question.explanation ? " 解析：" + question.explanation : "");
          question.__feedback.classList.add(ok ? "ok" : "bad");
        });
        App.showToast(
          "练习完成：正确 " + result.correct + " / " + result.total +
          "（正确率 " + Math.round((result.accuracy || 0) * 100) + "%），已更新你的学习档案。");
        if (options && options.onSubmitted) options.onSubmitted();
      } catch (error) {
        App.showToast(error.message, "error");
        submit.disabled = false;
        submit.textContent = "提交答案";
      }
    });
    actions.appendChild(submit);
    container.appendChild(actions);
  }

  function render(reportContainer, questionsContainer, practice, options) {
    renderReport(reportContainer, practice && practice.report);
    renderQuestions(questionsContainer, practice, options);
  }

  return { render: render, renderReport: renderReport };
})();
