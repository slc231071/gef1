"use strict";

(function () {
  const homeworkId = window.__HOMEWORK_ID__;
  const titleEl = document.getElementById("homework-title");
  const descriptionEl = document.getElementById("homework-description");
  const metaEl = document.getElementById("hw-meta");
  const roleChip = document.getElementById("role-chip");
  const backLink = document.getElementById("back-link");

  const tabs = document.getElementById("hw-tabs");
  const tabPrimary = document.getElementById("tab-primary");
  const tabSecondary = document.getElementById("tab-secondary");
  const panePrimary = document.getElementById("pane-primary");
  const paneSecondary = document.getElementById("pane-secondary");

  const instructionsText = document.getElementById("instructions-text");
  const rosterWrap = document.getElementById("work-roster");
  const rosterSummary = document.getElementById("roster-summary");
  const rosterFilters = document.getElementById("roster-filters");
  const rosterList = document.getElementById("roster-list");
  const viewerModal = document.getElementById("viewer-modal");
  const viewerModalTitle = document.getElementById("viewer-modal-title");
  const viewerModalClose = document.getElementById("viewer-modal-close");
  const viewerScanner = document.getElementById("viewer-scanner");

  const workTitle = document.getElementById("work-title");
  const workStatus = document.getElementById("work-status");
  const workThumbs = document.getElementById("work-thumbs");
  const workAdd = document.getElementById("work-add");
  const workSubmit = document.getElementById("work-submit");
  const workSave = document.getElementById("work-save");
  const workCancel = document.getElementById("work-cancel");
  const workNote = document.getElementById("work-note");

  const scanModal = document.getElementById("scan-modal");
  const scanModalTitle = document.getElementById("scan-modal-title");
  const scanModalKicker = document.getElementById("scan-modal-kicker");
  const scanModalClose = document.getElementById("scan-modal-close");
  const scanModalPrimary = document.getElementById("scan-modal-primary");

  let me = null;
  let homeworkData = null;
  let work = null;          // scanner for the user's own work (answer / submission)
  let workLoaded = false;
  let viewer = null;        // teacher submission viewer
  let viewerOwner = null;
  let roster = [];
  let rosterFilter = "all";

  function isTeacher() { return me && me.role === "teacher"; }

  function metaChip(text, className) {
    const span = document.createElement("span");
    span.className = "hw-meta-chip" + (className ? " " + className : "");
    span.textContent = text;
    return span;
  }

  function renderBanner() {
    const h = homeworkData.homework;
    titleEl.textContent = h.title;
    descriptionEl.textContent = h.description || (isTeacher() ? "点击添加说明…" : "");
    document.title = h.title + " · 智学伴";

    metaEl.replaceChildren();
    if (h.classroom_name && h.classroom_id) {
      const chip = document.createElement("a");
      chip.className = "hw-meta-chip";
      chip.href = "/classroom/" + h.classroom_id;
      chip.textContent = "教室 · " + h.classroom_name;
      metaEl.appendChild(chip);
    }
    metaEl.appendChild(metaChip("老师 " + (h.created_by || "—")));
    metaEl.appendChild(metaChip("创建 " + App.relativeTime(h.created_at)));
    if (isTeacher()) {
      metaEl.appendChild(metaChip("标准答案 " + h.answer_pages + " 页", "hw-meta-answer"));
      metaEl.appendChild(metaChip(
        "已提交 " + h.submitters + " 人 / " + h.submitted_pages + " 页" +
        (h.draft_pages ? " · 草稿 " + h.draft_pages + " 页" : "")
      ));
    } else if (h.submitted_pages) {
      metaEl.appendChild(metaChip("已提交 " + h.submitted_pages + " 页"));
    } else if (h.draft_pages) {
      metaEl.appendChild(metaChip("草稿 " + h.draft_pages + " 页"));
    } else {
      metaEl.appendChild(metaChip("未提交"));
    }
  }

  // ---------- Inline title / description editing (teacher only) ----------
  let titleEditing = false;
  let descEditing = false;

  async function saveHomeworkFields(fields) {
    try {
      const data = await App.apiJson("/api/homework/" + homeworkId, "PUT", fields);
      homeworkData.homework = data.homework;
      renderBanner();
      App.showToast("已保存修改。");
    } catch (error) {
      App.showToast(error.message, "error");
      renderBanner();
    }
  }

  function makeTitleEditable() {
    titleEl.classList.add("hw-editable");
    titleEl.tabIndex = 0;
    titleEl.title = "点击修改标题";
    titleEl.addEventListener("click", startTitleEdit);
    titleEl.addEventListener("keydown", function (event) {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); startTitleEdit(); }
    });
  }

  function startTitleEdit() {
    if (titleEditing || !homeworkData || titleEl.querySelector("input")) return;
    titleEditing = true;
    const current = homeworkData.homework.title;
    titleEl.replaceChildren();
    const input = document.createElement("input");
    input.type = "text";
    input.className = "hw-title-input";
    input.value = current;
    input.maxLength = 120;
    input.setAttribute("aria-label", "作业标题");
    titleEl.appendChild(input);
    input.focus();
    input.select();
    let done = false;
    function finish(save) {
      if (done) return;
      done = true;
      titleEditing = false;
      const value = input.value.trim();
      if (save && value && value !== current) {
        saveHomeworkFields({ title: value });
      } else {
        renderBanner();
      }
    }
    input.addEventListener("keydown", function (event) {
      if (event.key === "Enter") { event.preventDefault(); finish(true); }
      else if (event.key === "Escape") { event.preventDefault(); finish(false); }
    });
    input.addEventListener("blur", function () { finish(true); });
  }

  function makeDescriptionEditable() {
    descriptionEl.classList.add("hw-editable");
    descriptionEl.tabIndex = 0;
    descriptionEl.title = "点击修改说明";
    descriptionEl.addEventListener("click", startDescriptionEdit);
    descriptionEl.addEventListener("keydown", function (event) {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); startDescriptionEdit(); }
    });
  }

  function startDescriptionEdit() {
    if (descEditing || !homeworkData || descriptionEl.querySelector("textarea")) return;
    descEditing = true;
    const current = homeworkData.homework.description || "";
    descriptionEl.replaceChildren();
    const area = document.createElement("textarea");
    area.className = "hw-desc-input";
    area.value = current;
    area.rows = 2;
    area.maxLength = 500;
    area.setAttribute("aria-label", "作业说明");
    descriptionEl.appendChild(area);
    area.focus();
    let done = false;
    function finish(save) {
      if (done) return;
      done = true;
      descEditing = false;
      const value = area.value.trim();
      if (save && value !== current) {
        saveHomeworkFields({ description: value });
      } else {
        renderBanner();
      }
    }
    area.addEventListener("keydown", function (event) {
      if (event.key === "Escape") { event.preventDefault(); finish(false); }
    });
    area.addEventListener("blur", function () { finish(true); });
  }

  function activate(tab, pane) {
    [[tabPrimary, panePrimary], [tabSecondary, paneSecondary]].forEach(function (pair) {
      const on = pair[0] === tab;
      pair[0].classList.toggle("active", on);
      pair[0].setAttribute("aria-selected", on ? "true" : "false");
      pair[1].hidden = !on;
    });
  }
  tabPrimary.addEventListener("click", function () { activate(tabPrimary, panePrimary); });
  tabSecondary.addEventListener("click", function () { activate(tabSecondary, paneSecondary); });

  // Teacher: list every student first, then show the selected one's submission.
  function buildRoster() {
    const submitted = {};
    const drafts = {};
    (homeworkData.pages || []).forEach(function (page) {
      if (page.kind !== "submission") return;
      if (page.status === "submitted") {
        submitted[page.owner] = (submitted[page.owner] || 0) + 1;
      } else {
        drafts[page.owner] = (drafts[page.owner] || 0) + 1;
      }
    });
    roster = (homeworkData.students || []).map(function (name) {
      return { name: name, submitted: submitted[name] || 0, draft: drafts[name] || 0 };
    });
    const submittedCount = roster.filter(function (r) { return r.submitted > 0; }).length;
    const draftCount = roster.filter(function (r) { return r.submitted === 0 && r.draft > 0; }).length;
    rosterSummary.textContent = "已提交 " + submittedCount + " · 草稿 " + draftCount +
      " · 未提交 " + (roster.length - submittedCount - draftCount) + " · 共 " + roster.length + " 人";

    rosterFilters.replaceChildren();
    [["all", "全部"], ["submitted", "已提交"], ["draft", "草稿"], ["pending", "未提交"]].forEach(function (pair) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip" + (rosterFilter === pair[0] ? " active" : "");
      chip.textContent = pair[1];
      chip.addEventListener("click", function () { rosterFilter = pair[0]; buildRoster(); });
      rosterFilters.appendChild(chip);
    });

    rosterList.replaceChildren();
    const visible = roster.filter(function (r) {
      if (rosterFilter === "submitted") return r.submitted > 0;
      if (rosterFilter === "draft") return r.submitted === 0 && r.draft > 0;
      if (rosterFilter === "pending") return r.submitted === 0 && r.draft === 0;
      return true;
    });
    if (!visible.length) {
      const li = document.createElement("li");
      li.className = "muted";
      li.textContent = "没有符合条件的学生。";
      rosterList.appendChild(li);
      return;
    }
    visible.forEach(function (entry) {
      const li = document.createElement("li");
      li.className = "roster-row" + (entry.name === viewerOwner ? " active" : "");
      const avatar = document.createElement("span");
      avatar.className = "avatar";
      avatar.textContent = entry.name.slice(0, 1).toUpperCase();
      const name = document.createElement("span");
      name.className = "roster-name";
      name.textContent = entry.name;
      const badge = document.createElement("span");
      if (entry.submitted) {
        badge.className = "badge badge-done";
        badge.textContent = "已提交 " + entry.submitted + " 页";
      } else if (entry.draft) {
        badge.className = "badge badge-pending";
        badge.textContent = "草稿 " + entry.draft + " 页";
      } else {
        badge.className = "badge badge-muted";
        badge.textContent = "未提交";
      }
      const open = document.createElement("button");
      open.type = "button";
      open.className = "tool-button";
      open.textContent = "查看";
      open.addEventListener("click", function () { selectStudent(entry.name); });
      const grade = document.createElement("button");
      grade.type = "button";
      grade.className = "tool-button grade-link";
      grade.textContent = "批改";
      grade.title = "进入批改页面";
      grade.addEventListener("click", function () {
        window.location.href = "/homework/" + homeworkId + "/grade?student=" +
          encodeURIComponent(entry.name);
      });
      li.append(avatar, name, badge, open, grade);
      rosterList.appendChild(li);
    });
  }

  function closeViewer() {
    viewerModal.hidden = true;
    if (scanModal.hidden) document.body.classList.remove("modal-open");
  }

  async function selectStudent(name) {
    viewerOwner = name;
    buildRoster();
    const entry = roster.filter(function (r) { return r.name === name; })[0];
    const suffix = entry && entry.submitted ? "的提交" : (entry && entry.draft ? "的草稿" : "的作业");
    viewerModalTitle.textContent = name + " " + suffix;
    viewerModal.hidden = false;
    document.body.classList.add("modal-open");
    try {
      if (!viewer) {
        viewer = Converter.createScanner(viewerScanner, {
          homeworkId: homeworkId,
          kind: "submission",
          readOnly: true,
          ownerFilter: name,
        });
        await viewer.load();
      } else {
        await viewer.setOwner(name);
      }
    } catch (error) {
      App.showToast(error.message, "error");
    }
  }

  async function loadHomework() {
    const data = await App.api("/api/homework/" + homeworkId);
    homeworkData = data;
    renderGradedView(data);
    setupPractice(data);
    return data;
  }

  // ---------- Teacher grading view (students, returned work only) ----------
  function renderGradedView(data) {
    const view = document.getElementById("graded-view");
    const container = document.getElementById("graded-pages");
    if (!view || !container) return;
    const returned = !isTeacher() && data.grading_status === "returned";
    const drawings = returned ? (data.grading_drawings || {}) : {};
    const hasMarks = Object.keys(drawings).some(function (key) {
      return (drawings[key] || []).length > 0;
    });
    if (!returned || !hasMarks) {
      view.hidden = true;
      container.replaceChildren();
      return;
    }
    view.hidden = false;
    container.replaceChildren();
    data.pages.forEach(function (page, index) {
      const items = drawings[String(index)] || [];
      if (!items.length) return;
      const wrap = document.createElement("div");
      wrap.className = "graded-page";
      const label = document.createElement("p");
      label.className = "graded-page-label";
      label.textContent = "第 " + (index + 1) + " 页";
      const stage = document.createElement("div");
      stage.className = "graded-page-stage";
      const img = document.createElement("img");
      img.src = page.image_url || ("/uploads/" + page.image_filename);
      img.alt = "第 " + (index + 1) + " 页";
      const canvas = document.createElement("canvas");
      stage.append(img, canvas);
      wrap.append(label, stage);
      container.appendChild(wrap);
      const draw = function () {
        const ratio = window.devicePixelRatio || 1;
        const width = img.clientWidth || img.naturalWidth;
        const height = img.clientHeight || img.naturalHeight;
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(height * ratio);
        canvas.style.width = width + "px";
        canvas.style.height = height + "px";
        GradingDraw.drawAll(canvas.getContext("2d"), items, img);
      };
      if (img.complete) draw();
      else img.onload = draw;
    });
    App.showToast("老师已发还批改结果，请查看「老师批改」。");
  }

  // ---------- Student AI practice (after the work is returned) ----------
  const practiceView = document.getElementById("practice-view");
  const practiceGenerate = document.getElementById("practice-generate");
  const practiceReport = document.getElementById("practice-report");
  const practiceQuestions = document.getElementById("practice-questions");
  const practiceIntro = document.getElementById("practice-intro");

  function renderPractice(practice) {
    if (!practice) {
      practiceReport.replaceChildren();
      practiceQuestions.replaceChildren();
      return;
    }
    practiceIntro.hidden = true;
    practiceGenerate.textContent = "🔄 重新生成练习";
    window.PracticeUI.render(practiceReport, practiceQuestions, practice);
  }

  async function setupPractice(data) {
    if (!practiceView) return;
    const returned = !isTeacher() && data.grading_status === "returned";
    if (!returned) {
      practiceView.hidden = true;
      return;
    }
    practiceView.hidden = false;
    try {
      const payload = await App.api("/api/homework/" + homeworkId + "/practice");
      renderPractice(payload.practice);
    } catch (_error) { /* no practice yet — keep the generate button */ }
  }

  practiceGenerate.addEventListener("click", async function () {
    practiceGenerate.disabled = true;
    const withQuestions = document.getElementById("practice-with-questions");
    const wantQuestions = !withQuestions || withQuestions.checked;
    const original = wantQuestions ? "🔄 重新生成练习" : "🔄 重新生成报告";
    practiceGenerate.textContent = wantQuestions
      ? "🤖 AI 正在结合你的档案生成报告与练习…"
      : "🤖 AI 正在结合你的档案生成学习报告…";
    try {
      const payload = await App.apiJson(
        "/api/homework/" + homeworkId + "/practice/generate", "POST",
        { with_questions: wantQuestions });
      renderPractice(payload.practice);
      App.showToast(wantQuestions
        ? "报告与练习已生成，开始巩固薄弱知识点吧！"
        : "学习报告已生成，可在档案页查看你的知识画像。");
    } catch (error) {
      App.showToast(error.message, "error");
    } finally {
      practiceGenerate.disabled = false;
      practiceGenerate.textContent = original;
    }
  });

  // ---------- "Your work" card ----------
  function renderWorkCard(meta) {
    let count = 0;
    let dirty = false;
    let busy = false;
    let submitted = false;
    if (meta) {
      count = meta.pageCount;
      dirty = meta.dirty;
      busy = meta.busy;
      submitted = meta.status === "submitted";
    } else if (work) {
      const current = work.getMeta();
      count = current.pageCount;
      dirty = current.dirty;
      busy = current.busy;
      submitted = current.status === "submitted";
    } else if (homeworkData) {
      // Before the popup (and its scanner) is opened, fall back to the server
      // counts so an already-saved submission still shows up after a reload.
      count = isTeacher() ? homeworkData.homework.answer_pages : homeworkData.homework.submission_pages;
      submitted = !isTeacher() && (homeworkData.homework.submitted_pages || 0) > 0;
    }
    const teacher = isTeacher();

    workThumbs.replaceChildren();
    if (count) {
      for (let i = 0; i < count; i++) {
        const chip = document.createElement("span");
        chip.className = "work-thumb";
        chip.textContent = String(i + 1);
        workThumbs.appendChild(chip);
      }
    } else {
      const empty = document.createElement("span");
      empty.className = "muted";
      empty.textContent = teacher ? "尚未上传标准答案。" : "还没有扫描作业。";
      workThumbs.appendChild(empty);
    }

    if (teacher) {
      workStatus.className = "badge " + (count ? (dirty ? "badge-pending" : "badge-done") : "badge-muted");
      workStatus.textContent = count ? (dirty ? "有未保存修改" : ("已上传 " + count + " 页")) : "未上传";
    } else if (!count) {
      workStatus.className = "badge badge-pending";
      workStatus.textContent = "未提交";
    } else if (dirty) {
      workStatus.className = "badge badge-pending";
      workStatus.textContent = "有未保存修改";
    } else if (submitted) {
      workStatus.className = "badge badge-done";
      workStatus.textContent = "已提交 " + count + " 页";
    } else {
      workStatus.className = "badge badge-pending";
      workStatus.textContent = "草稿 " + count + " 页";
    }

    workSave.hidden = !teacher;
    // Students: "提交作业" appears for a saved draft, "取消提交" for a finished
    // submission. Neither is shown while there are unsaved edits.
    workSubmit.hidden = teacher || !count || dirty || submitted;
    workCancel.hidden = teacher || !count || dirty || !submitted;
    workSubmit.disabled = busy;
    workCancel.disabled = busy;
    workAdd.textContent = count ? "继续编辑" : (teacher ? "+ 添加标准答案" : "+ 添加作业");
    workNote.textContent = teacher
      ? "学生无法查看标准答案，仅供老师备查。"
      : "先在扫描器中「保存作业」，确认无误后再点「提交作业」。";
  }

  // ---------- Scan popup ----------
  function ensureWorkScanner() {
    if (work) return;
    work = Converter.createScanner(document.getElementById("modal-scanner"), {
      homeworkId: homeworkId,
      kind: isTeacher() ? "answer" : "submission",
      readOnly: false,
      confirmSubmit: !isTeacher(),
      saveStatus: isTeacher() ? "submitted" : "draft",
      hideSaveButton: true,
      enableCamera: true,
      onChange: renderWorkCard,
    });
  }

  // Create the scanner and load the saved pages without opening the popup, so
  // the card's "提交作业"/"保存" buttons work even after a page reload.
  async function ensureWorkLoaded() {
    ensureWorkScanner();
    if (!workLoaded) {
      workLoaded = true;
      await work.load();
    }
  }

  function openModal() {
    ensureWorkLoaded();
    scanModalTitle.textContent = isTeacher() ? "标准答案" : "扫描作业";
    scanModalKicker.textContent = isTeacher() ? "标准答案" : "扫描与保存";
    scanModalPrimary.textContent = isTeacher() ? "保存标准答案" : "保存作业";
    scanModal.hidden = false;
    document.body.classList.add("modal-open");
    renderWorkCard(work.getMeta());
  }

  function closeModal() {
    scanModal.hidden = true;
    if (viewerModal.hidden) document.body.classList.remove("modal-open");
    if (work) work.stopCamera();
    renderWorkCard(work ? work.getMeta() : null);
  }

  workAdd.addEventListener("click", openModal);
  scanModalClose.addEventListener("click", closeModal);
  scanModal.addEventListener("click", function (event) { if (event.target === scanModal) closeModal(); });
  viewerModalClose.addEventListener("click", closeViewer);
  viewerModal.addEventListener("click", function (event) { if (event.target === viewerModal) closeViewer(); });
  document.addEventListener("keydown", function (event) {
    if (event.key !== "Escape") return;
    if (!viewerModal.hidden) closeViewer();
    else if (!scanModal.hidden) closeModal();
  });

  async function afterSave() {
    try { await loadHomework(); renderBanner(); } catch (_error) { /* ignore */ }
    if (isTeacher()) buildRoster();
    renderWorkCard(work ? work.getMeta() : null);
  }

  workSubmit.addEventListener("click", async function () {
    await ensureWorkLoaded();
    await work.submit();
    await afterSave();
  });
  workSave.addEventListener("click", async function () {
    await ensureWorkLoaded();
    await work.save();
    await afterSave();
  });

  // Student: withdraw an already-submitted homework back to a draft.
  async function cancelSubmission() {
    const ok = await App.confirmDialog({
      title: "取消提交",
      message: "确认取消提交吗？取消后作业会回到草稿状态，你可以继续修改后再次提交。",
      confirmText: "取消提交",
      cancelText: "暂不取消",
    });
    if (!ok) return;
    try {
      await App.apiJson("/api/homework/" + homeworkId + "/submission", "PUT", { status: "draft" });
      App.showToast("已取消提交，作业已回到草稿状态。");
      if (work) await work.load();
      await afterSave();
    } catch (error) {
      App.showToast(error.message, "error");
    }
  }

  workCancel.addEventListener("click", cancelSubmission);

  // Primary action inside the popup so the flow is self-contained.
  scanModalPrimary.addEventListener("click", async function () {
    if (!work) return;
    const wasDirty = work.getMeta().dirty;
    if (isTeacher()) {
      await work.save();
      closeModal();
    } else {
      // The student saves a draft first; submitting is a separate step.
      await work.save();
      if (wasDirty && !work.getMeta().dirty) closeModal();
    }
    await afterSave();
  });

  async function init() {
    try {
      me = await App.loadMe();
      roleChip.textContent = isTeacher() ? "老师端" : "学生端";

      if (isTeacher()) {
        tabs.hidden = false;
        tabPrimary.textContent = "学生作业";
        tabSecondary.textContent = "说明";
        rosterWrap.hidden = false;
        activate(tabPrimary, panePrimary);
        makeTitleEditable();
        makeDescriptionEditable();
      } else {
        // Students never see the standard answer — instructions + own work only.
        tabs.hidden = true;
        panePrimary.hidden = true;
        paneSecondary.hidden = false;
      }

      workTitle.textContent = isTeacher() ? "标准答案" : "你的作业";
      renderWorkCard(null);

      await loadHomework();
      renderBanner();
      const hwMeta = homeworkData.homework;
      if (hwMeta.classroom_id) {
        backLink.href = "/classroom/" + hwMeta.classroom_id;
        backLink.textContent = "← 返回教室";
        if (window.AppSidebar) window.AppSidebar.setActive(hwMeta.classroom_id);
      } else {
        backLink.href = isTeacher() ? "/teacher" : "/student";
      }
      instructionsText.textContent = homeworkData.homework.description || "老师暂未填写说明。";
      renderWorkCard(null);
      if (isTeacher()) buildRoster();
    } catch (error) {
      App.showToast(error.message, "error");
    }
  }

  init();
})();
