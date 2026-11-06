"use strict";

// Classroom grid dashboard shared by the teacher and student ends.
(function () {
  const grid = document.getElementById("classroom-grid");
  const searchInput = document.getElementById("classroom-search");
  const createBtn = document.getElementById("create-classroom");
  const joinBtn = document.getElementById("join-classroom");

  let classrooms = [];

  function emptyState(title, hint) {
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
    return wrap;
  }

  function badge(text, className) {
    const span = document.createElement("span");
    span.className = "badge " + className;
    span.textContent = text;
    return span;
  }

  function classroomCard(room) {
    const a = document.createElement("a");
    a.className = "classroom-card";
    a.href = "/classroom/" + room.id;
    a.dataset.search = ((room.name || "") + " " + (room.section || "") + " " +
      (room.description || "")).toLowerCase();

    const top = document.createElement("div");
    top.className = "classroom-card-top";
    const mark = document.createElement("span");
    mark.className = "classroom-card-mark";
    mark.textContent = (room.name || "?").slice(0, 1).toUpperCase();
    const head = document.createElement("div");
    const name = document.createElement("div");
    name.className = "classroom-card-name";
    name.textContent = room.name;
    head.appendChild(name);
    if (room.section) {
      const section = document.createElement("div");
      section.className = "classroom-card-section";
      section.textContent = room.section;
      head.appendChild(section);
    }
    top.append(mark, head);

    const desc = document.createElement("p");
    desc.className = "classroom-card-desc";
    desc.textContent = room.description || "暂无说明";

    const stats = document.createElement("div");
    stats.className = "classroom-card-stats";
    stats.append(
      badge("学生 " + room.student_count, "badge-muted"),
      badge("老师 " + room.teacher_count, "badge-owner"),
      badge("作业 " + room.homework_count, "badge-answer")
    );
    if (room.my_role === "teacher" && !room.is_owner) {
      stats.appendChild(badge("协同管理", "badge-done"));
    }

    a.append(top, desc, stats);
    return a;
  }

  function applyFilter() {
    const query = (searchInput ? searchInput.value : "").trim().toLowerCase();
    let visible = 0;
    const note = grid.querySelector(".filter-note");
    if (note) note.remove();
    Array.prototype.forEach.call(grid.children, function (child) {
      if (!child.dataset || child.dataset.search === undefined) return;
      const match = !query || child.dataset.search.indexOf(query) !== -1;
      child.hidden = !match;
      if (match) visible += 1;
    });
    if (query && visible === 0) {
      const note = document.createElement("p");
      note.className = "filter-note muted";
      note.textContent = "没有匹配「" + query + "」的教室。";
      grid.appendChild(note);
    }
  }

  function render() {
    grid.replaceChildren();
    if (!classrooms.length) {
      grid.appendChild(emptyState("还没有教室", "点击右上角创建或加入一个教室吧。"));
      return;
    }
    for (const room of classrooms) grid.appendChild(classroomCard(room));
    applyFilter();
  }

  async function load() {
    try {
      const data = await App.api("/api/classrooms");
      classrooms = data.classrooms || [];
      render();
    } catch (error) {
      grid.replaceChildren();
      grid.appendChild(emptyState("加载失败", error.message));
      App.showToast(error.message, "error");
    }
  }

  if (searchInput) searchInput.addEventListener("input", applyFilter);
  if (createBtn) createBtn.addEventListener("click", function () { window.AppSidebar.openCreate(); });
  if (joinBtn) joinBtn.addEventListener("click", function () { window.AppSidebar.openJoin(); });

  App.loadMe().catch(function () {});
  load();
})();
