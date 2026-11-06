"use strict";

(function () {
  const classroomId = window.__CLASSROOM_ID__;
  const nameEl = document.getElementById("classroom-name");
  const descEl = document.getElementById("classroom-desc");
  const kickerEl = document.getElementById("classroom-kicker");
  const codeWrap = document.getElementById("classroom-code-wrap");
  const toolsEl = document.getElementById("classroom-tools");
  const backLink = document.getElementById("back-link");
  const roleChip = document.getElementById("role-chip");

  const tabHomework = document.getElementById("tab-homework");
  const tabMembers = document.getElementById("tab-members");
  const paneHomework = document.getElementById("pane-homework");
  const paneMembers = document.getElementById("pane-members");

  const homeworkList = document.getElementById("homework-list");
  const searchInput = document.getElementById("homework-search");
  const createWrap = document.getElementById("create-homework-wrap");
  const form = document.getElementById("create-homework-form");
  const titleInput = document.getElementById("homework-title");
  const descriptionInput = document.getElementById("homework-description");

  const memberList = document.getElementById("member-list");
  const memberTools = document.getElementById("member-tools");
  const addMemberBtn = document.getElementById("add-member");
  const addTeacherBtn = document.getElementById("add-teacher");

  let me = null;
  let classroom = null;
  let homeworks = [];

  function isManager() { return !!(classroom && classroom.can_manage); }

  function emptyLi(title, hint) {
    const li = document.createElement("li");
    const wrap = document.createElement("div");
    wrap.className = "empty-state";
    const icon = document.createElement("div");
    icon.className = "empty-icon";
    icon.textContent = "◧";
    const strong = document.createElement("strong");
    strong.textContent = title;
    const span = document.createElement("span");
    span.className = "muted";
    span.textContent = hint;
    wrap.append(icon, strong, span);
    li.appendChild(wrap);
    return li;
  }

  function homeworkItem(h) {
    const li = document.createElement("li");
    li.className = "homework-card";
    li.dataset.search = ((h.title || "") + " " + (h.description || "")).toLowerCase();

    const main = document.createElement("div");
    main.className = "homework-card-main";
    const link = document.createElement("a");
    link.className = "homework-card-title";
    link.href = "/homework/" + h.id;
    link.textContent = h.title;
    const desc = document.createElement("span");
    desc.className = "homework-card-desc";
    desc.textContent = h.description || "无说明";
    main.append(link, desc);
    if (h.created_at) {
      const time = document.createElement("span");
      time.className = "homework-card-time";
      time.textContent = App.relativeTime(h.created_at);
      main.appendChild(time);
    }

    const meta = document.createElement("div");
    meta.className = "homework-card-meta";
    if (isManager()) {
      const answerTag = document.createElement("span");
      answerTag.className = "badge badge-answer";
      answerTag.textContent = "标准答案 " + h.answer_pages;
      const submitTag = document.createElement("span");
      submitTag.className = "badge " + (h.submitters ? "badge-done" : "badge-muted");
      submitTag.textContent = "提交 " + h.submitters + " 人 / " + h.submitted_pages + " 页" +
        (h.draft_pages ? " · 草稿 " + h.draft_pages + " 页" : "");
      const del = document.createElement("button");
      del.type = "button";
      del.className = "danger-text";
      del.textContent = "删除";
      del.addEventListener("click", function () { deleteHomework(h, del); });
      meta.append(answerTag, submitTag, del);
    } else if (h.submitted_pages) {
      const tag = document.createElement("span");
      tag.className = "badge badge-done";
      tag.textContent = "已提交 " + h.submitted_pages + " 页";
      meta.appendChild(tag);
    } else if (h.draft_pages) {
      const tag = document.createElement("span");
      tag.className = "badge badge-pending";
      tag.textContent = "草稿 " + h.draft_pages + " 页";
      meta.appendChild(tag);
    } else {
      const tag = document.createElement("span");
      tag.className = "badge badge-pending";
      tag.textContent = "未提交";
      meta.appendChild(tag);
    }

    li.append(main, meta);
    return li;
  }

  async function deleteHomework(h, button) {
    const ok = await App.confirmDialog({
      title: "删除作业",
      message: "确定删除作业「" + h.title + "」？此操作不可恢复。",
      confirmText: "删除",
      cancelText: "取消",
      danger: true,
    });
    if (!ok) return;
    button.disabled = true;
    try {
      await App.apiJson("/api/homework/" + h.id, "DELETE");
      App.showToast("已删除作业。");
      renderHomework();
    } catch (error) {
      App.showToast(error.message, "error");
      button.disabled = false;
    }
  }

  function applyFilter() {
    const query = (searchInput ? searchInput.value : "").trim().toLowerCase();
    let visible = 0;
    const note = homeworkList.querySelector(".filter-note");
    if (note) note.remove();
    Array.prototype.forEach.call(homeworkList.children, function (child) {
      if (!child.dataset || child.dataset.search === undefined) return;
      const match = !query || child.dataset.search.indexOf(query) !== -1;
      child.hidden = !match;
      if (match) visible += 1;
    });
    if (query && visible === 0) {
      const li = document.createElement("li");
      li.className = "filter-note muted";
      li.textContent = "没有匹配「" + query + "」的作业。";
      homeworkList.appendChild(li);
    }
  }

  function renderHomework() {
    homeworkList.replaceChildren();
    if (!homeworks.length) {
      homeworkList.appendChild(emptyLi(
        "还没有作业",
        isManager() ? "在上方布置第一份作业吧。" : "老师还没有布置作业。"
      ));
      return;
    }
    for (const h of homeworks) homeworkList.appendChild(homeworkItem(h));
    applyFilter();
  }

  function renderMembers() {
    memberList.replaceChildren();
    (classroom.members || []).forEach(function (member) {
      const li = document.createElement("li");
      li.className = "member-row";
      const avatar = document.createElement("span");
      avatar.className = "avatar";
      avatar.textContent = member.username.slice(0, 1).toUpperCase();
      const name = document.createElement("span");
      name.className = "member-name";
      name.textContent = member.username;
      const badge = document.createElement("span");
      if (member.role === "teacher") {
        badge.className = "badge badge-owner";
        badge.textContent = member.username === classroom.created_by ? "创建者" : "老师";
      } else {
        badge.className = "badge badge-muted";
        badge.textContent = "学生";
      }
      li.append(avatar, name, badge);
      if (isManager() && member.username !== classroom.created_by) {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "danger-text";
        remove.textContent = "移除";
        remove.addEventListener("click", function () { removeMember(member.username); });
        li.appendChild(remove);
      }
      memberList.appendChild(li);
    });
    memberTools.hidden = !isManager();
  }

  function renderCode() {
    codeWrap.replaceChildren();
    if (!classroom || !classroom.join_code) return;
    const box = document.createElement("div");
    box.className = "classroom-code";
    const label = document.createElement("span");
    label.className = "classroom-code-label";
    label.textContent = "邀请码";
    const value = document.createElement("span");
    value.className = "classroom-code-value";
    value.textContent = classroom.join_code;
    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = "复制";
    copy.addEventListener("click", function () {
      App.copyText(classroom.join_code).then(function () {
        App.showToast("邀请码已复制。");
      }).catch(function () {
        App.showToast("复制失败，请手动复制。", "error");
      });
    });
    box.append(label, value, copy);
    codeWrap.appendChild(box);
  }

  function renderBanner() {
    nameEl.textContent = classroom.name;
    descEl.textContent = classroom.description || (isManager() ? "点击「编辑教室」补充说明…" : "");
    document.title = classroom.name + " · 智学伴";
    kickerEl.textContent = "教室 · " + classroom.member_count + " 位成员 · " +
      classroom.homework_count + " 份作业";
    renderCode();
  }

  function toolButton(text, className, handler) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = text;
    button.addEventListener("click", handler);
    return button;
  }

  function renderTools() {
    toolsEl.replaceChildren();
    if (isManager()) {
      toolsEl.appendChild(toolButton("编辑教室", "secondary-button", editClassroom));
    }
    if (classroom.is_owner) {
      toolsEl.appendChild(toolButton("重置邀请码", "secondary-button", regenerateCode));
      toolsEl.appendChild(toolButton("删除教室", "danger-button", deleteClassroom));
    }
    if (!classroom.is_owner) {
      toolsEl.appendChild(toolButton("退出教室", "danger-button", leaveClassroom));
    }
  }

  async function editClassroom() {
    const values = await App.formDialog({
      title: "编辑教室",
      submitText: "保存",
      fields: [
        { name: "name", label: "教室名称", required: true, maxlength: 120, value: classroom.name },
        { name: "section", label: "班级 / 分组（可选）", maxlength: 120, value: classroom.section || "" },
        { name: "description", label: "教室说明（可选）", textarea: true, maxlength: 300, value: classroom.description || "" },
      ],
    });
    if (!values) return;
    try {
      const data = await App.apiJson("/api/classrooms/" + classroomId, "PUT", values);
      Object.assign(classroom, data.classroom);
      renderBanner();
      if (window.AppSidebar) window.AppSidebar.refresh();
      App.showToast("教室已更新。");
    } catch (error) {
      App.showToast(error.message, "error");
    }
  }

  async function regenerateCode() {
    const ok = await App.confirmDialog({
      title: "重置邀请码",
      message: "重置后旧的邀请码立即失效，需要把新邀请码重新发给成员。",
      confirmText: "重置",
      cancelText: "取消",
    });
    if (!ok) return;
    try {
      const data = await App.apiJson("/api/classrooms/" + classroomId + "/code", "POST", {});
      classroom.join_code = data.join_code;
      renderCode();
      App.showToast("邀请码已重置。");
    } catch (error) {
      App.showToast(error.message, "error");
    }
  }

  async function deleteClassroom() {
    const ok = await App.confirmDialog({
      title: "删除教室",
      message: "确定删除教室「" + classroom.name + "」？其中的作业与提交都会被删除，且不可恢复。",
      confirmText: "删除",
      cancelText: "取消",
      danger: true,
    });
    if (!ok) return;
    try {
      await App.apiJson("/api/classrooms/" + classroomId, "DELETE");
      App.showToast("教室已删除。");
      window.location.href = me && me.role === "teacher" ? "/teacher" : "/student";
    } catch (error) {
      App.showToast(error.message, "error");
    }
  }

  async function leaveClassroom() {
    const ok = await App.confirmDialog({
      title: "退出教室",
      message: "确定退出教室「" + classroom.name + "」？",
      confirmText: "退出",
      cancelText: "取消",
      danger: true,
    });
    if (!ok) return;
    try {
      await App.apiJson("/api/classrooms/" + classroomId + "/leave", "POST", {});
      App.showToast("已退出教室。");
      window.location.href = me && me.role === "teacher" ? "/teacher" : "/student";
    } catch (error) {
      App.showToast(error.message, "error");
    }
  }

  async function invite(teacherHint) {
    const values = await App.formDialog({
      title: teacherHint ? "邀请老师协同管理" : "邀请成员",
      message: "输入对方的用户名（需已存在账户）。老师加入后可与创建者共同管理本教室。",
      submitText: "邀请",
      fields: [{ name: "username", label: "用户名", required: true, maxlength: 60 }],
    });
    if (!values) return;
    try {
      await App.apiJson("/api/classrooms/" + classroomId + "/members", "POST", { username: values.username });
      App.showToast("已邀请 " + values.username + "。");
      await load();
    } catch (error) {
      App.showToast(error.message, "error");
    }
  }

  async function removeMember(username) {
    const ok = await App.confirmDialog({
      title: "移除成员",
      message: "确定把 " + username + " 移出本教室？",
      confirmText: "移除",
      cancelText: "取消",
      danger: true,
    });
    if (!ok) return;
    try {
      await App.apiJson("/api/classrooms/" + classroomId + "/members/" + encodeURIComponent(username), "DELETE");
      App.showToast("已移除 " + username + "。");
      await load();
    } catch (error) {
      App.showToast(error.message, "error");
    }
  }

  function activate(tab, pane) {
    [[tabHomework, paneHomework], [tabMembers, paneMembers]].forEach(function (pair) {
      const on = pair[0] === tab;
      pair[0].classList.toggle("active", on);
      pair[0].setAttribute("aria-selected", on ? "true" : "false");
      pair[1].hidden = !on;
    });
  }

  tabHomework.addEventListener("click", function () { activate(tabHomework, paneHomework); });
  tabMembers.addEventListener("click", function () { activate(tabMembers, paneMembers); });

  if (searchInput) searchInput.addEventListener("input", applyFilter);
  if (addMemberBtn) addMemberBtn.addEventListener("click", function () { invite(false); });
  if (addTeacherBtn) addTeacherBtn.addEventListener("click", function () { invite(true); });

  titleInput.addEventListener("input", function () {
    const field = titleInput.closest(".field");
    if (field) field.classList.remove("invalid");
  });

  form.addEventListener("submit", async function (event) {
    event.preventDefault();
    const title = titleInput.value.trim();
    const titleField = titleInput.closest(".field");
    if (!title) {
      if (titleField) titleField.classList.add("invalid");
      App.showToast("请填写作业标题。", "error");
      titleInput.focus();
      return;
    }
    if (titleField) titleField.classList.remove("invalid");
    const submit = form.querySelector("button[type=submit]");
    submit.disabled = true;
    const original = submit.textContent;
    submit.textContent = "创建中…";
    try {
      const data = await App.apiJson("/api/classrooms/" + classroomId + "/homework", "POST", {
        title: title,
        description: descriptionInput.value.trim(),
      });
      App.showToast("作业已创建，正在打开扫描页面…");
      window.location.href = "/homework/" + data.homework.id;
    } catch (error) {
      App.showToast(error.message, "error");
      submit.disabled = false;
      submit.textContent = original;
    }
  });

  async function load() {
    const data = await App.api("/api/classrooms/" + classroomId);
    me = data.me || me;
    classroom = data.classroom;
    homeworks = data.homeworks || [];
    createWrap.hidden = !isManager();
    renderBanner();
    renderTools();
    renderHomework();
    renderMembers();
    if (window.AppSidebar) window.AppSidebar.setActive(classroomId);
  }

  async function init() {
    try {
      me = await App.loadMe();
      roleChip.textContent = me.role === "teacher" ? "老师端" : "学生端";
      backLink.href = me.role === "teacher" ? "/teacher" : "/student";
      await load();
    } catch (error) {
      homeworkList.replaceChildren();
      homeworkList.appendChild(emptyLi("无法打开教室", error.message));
      App.showToast(error.message, "error");
    }
  }

  init();
})();
