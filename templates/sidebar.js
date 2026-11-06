"use strict";

// Shared classroom navigation shown on every authenticated page.
window.AppSidebar = (function () {
  const listEl = document.getElementById("sidebar-list");
  const actionsEl = document.getElementById("sidebar-actions");
  const homeEl = document.getElementById("sidebar-home");
  const sidebar = document.getElementById("app-sidebar");
  const toggle = document.getElementById("sidebar-toggle");
  const scrim = document.getElementById("sidebar-scrim");

  let me = null;
  let classrooms = [];
  let activeId = null;

  function closeMobile() {
    if (sidebar) sidebar.classList.remove("open");
    if (scrim) scrim.hidden = true;
    if (toggle) toggle.setAttribute("aria-expanded", "false");
  }

  function openMobile() {
    if (sidebar) sidebar.classList.add("open");
    if (scrim) scrim.hidden = false;
    if (toggle) toggle.setAttribute("aria-expanded", "true");
  }

  function renderNav() {
    if (homeEl) homeEl.href = me && me.role === "teacher" ? "/teacher" : "/student";
    if (!listEl) return;
    listEl.replaceChildren();
    if (!classrooms.length) {
      const li = document.createElement("li");
      li.className = "sidebar-empty muted";
      li.textContent = me && me.role === "teacher"
        ? "还没有教室，去新建一个吧。"
        : "还没有加入教室。";
      listEl.appendChild(li);
      return;
    }
    classrooms.forEach(function (room) {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.className = "sidebar-item";
      a.href = "/classroom/" + room.id;
      if (String(activeId) === String(room.id)) a.classList.add("active");
      const name = document.createElement("span");
      name.className = "sidebar-item-name";
      name.textContent = room.name;
      const count = document.createElement("span");
      count.className = "sidebar-item-count";
      count.textContent = room.member_count;
      count.title = room.member_count + " 位成员";
      a.append(name, count);
      li.appendChild(a);
      listEl.appendChild(li);
    });
  }

  function renderActions() {
    if (!actionsEl) return;
    actionsEl.replaceChildren();
    if (me && me.role === "teacher") {
      const create = document.createElement("button");
      create.type = "button";
      create.className = "primary-button sidebar-action";
      create.textContent = "＋ 新建教室";
      create.addEventListener("click", openCreate);
      actionsEl.appendChild(create);
    }
    const join = document.createElement("button");
    join.type = "button";
    join.className = "secondary-button sidebar-action";
    join.textContent = "加入教室";
    join.addEventListener("click", openJoin);
    actionsEl.appendChild(join);
  }

  async function openCreate() {
    const values = await App.formDialog({
      title: "新建教室",
      submitText: "创建",
      fields: [
        { name: "name", label: "教室名称", required: true, maxlength: 120, placeholder: "例如：高三(2)班 数学" },
        { name: "section", label: "班级 / 分组（可选）", maxlength: 120, placeholder: "例如：2026 春季" },
        { name: "description", label: "教室说明（可选）", textarea: true, maxlength: 300 },
      ],
    });
    if (!values) return;
    try {
      const data = await App.apiJson("/api/classrooms", "POST", values);
      App.showToast("教室已创建。");
      window.location.href = "/classroom/" + data.classroom.id;
    } catch (error) {
      App.showToast(error.message, "error");
    }
  }

  async function openJoin() {
    const values = await App.formDialog({
      title: "加入教室",
      message: "输入老师提供的邀请码即可加入。",
      submitText: "加入",
      fields: [
        { name: "join_code", label: "邀请码", required: true, maxlength: 12, placeholder: "例如：AB12CD" },
      ],
    });
    if (!values) return;
    try {
      const data = await App.apiJson("/api/classrooms/join", "POST", {
        join_code: values.join_code.toUpperCase(),
      });
      App.showToast(data.already_member ? "你已经在该教室中。" : "已加入教室。");
      window.location.href = "/classroom/" + data.classroom.id;
    } catch (error) {
      App.showToast(error.message, "error");
    }
  }

  async function load() {
    try { me = await App.loadMe(); } catch (_error) { me = null; }
    try {
      const data = await App.api("/api/classrooms");
      classrooms = data.classrooms || [];
    } catch (_error) {
      classrooms = [];
    }
    renderNav();
    renderActions();
  }

  function setActive(id) {
    activeId = id;
    renderNav();
  }

  function detectActive() {
    const match = /^\/classroom\/(\d+)/.exec(window.location.pathname);
    if (match) activeId = match[1];
  }

  detectActive();
  if (toggle) {
    toggle.addEventListener("click", function () {
      if (sidebar && sidebar.classList.contains("open")) closeMobile();
      else openMobile();
    });
  }
  if (scrim) scrim.addEventListener("click", closeMobile);

  load();

  return {
    load: load,
    refresh: load,
    setActive: setActive,
    openCreate: openCreate,
    openJoin: openJoin,
    getClassrooms: function () { return classrooms; },
  };
})();
