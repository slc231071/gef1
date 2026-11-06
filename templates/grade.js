"use strict";

// Teacher grading page: manual marks (click-to-annotate), free-hand drawing
// (Apple Pencil / touch / mouse) and optional AI-assisted annotations.
(function () {
  const homeworkId = window.__HOMEWORK_ID__;
  const titleEl = document.getElementById("grade-title");
  const metaEl = document.getElementById("grade-meta");
  const backLink = document.getElementById("back-link");
  const aiButton = document.getElementById("ai-assist");
  const prevBtn = document.getElementById("page-prev");
  const nextBtn = document.getElementById("page-next");
  const indicator = document.getElementById("page-indicator");
  const penColor = document.getElementById("pen-color");
  const undoBtn = document.getElementById("stroke-undo");
  const redoBtn = document.getElementById("stroke-redo");
  const stage = document.getElementById("grade-stage");
  const image = document.getElementById("grade-image");
  const canvas = document.getElementById("grade-canvas");
  const emptyEl = document.getElementById("grade-empty");
  const answerThumbs = document.getElementById("answer-thumbs");
  const toolPen = document.getElementById("tool-pen");
  const toolText = document.getElementById("tool-text");
  const toolShape = document.getElementById("tool-shape");
  const toolEraser = document.getElementById("tool-eraser");
  const shapeGroup = document.getElementById("shape-group");
  const aiCard = document.getElementById("ai-card");
  const aiCounter = document.getElementById("ai-counter");
  const aiVerdict = document.getElementById("ai-verdict");
  const aiText = document.getElementById("ai-text");
  const aiToggle = document.getElementById("ai-toggle");
  const aiDetail = document.getElementById("ai-detail");
  const pageRangeStart = document.getElementById("page-range-start");
  const pageRangeEnd = document.getElementById("page-range-end");
  const aiProgress = document.getElementById("ai-progress");
  const aiProgressText = document.getElementById("ai-progress-text");
  const aiProgressFill = document.getElementById("ai-progress-fill");
  const aiCompact = document.getElementById("ai-compact");
  const aiPrev = document.getElementById("ai-prev");
  const aiNext = document.getElementById("ai-next");
  const aiTick = document.getElementById("ai-tick");
  const aiCross = document.getElementById("ai-cross");
  const gradingStatus = document.getElementById("grading-status");
  const gradingSave = document.getElementById("grading-save");
  const gradingDiscard = document.getElementById("grading-discard");
  const gradingReturn = document.getElementById("grading-return");
  const gradingUnreturn = document.getElementById("grading-unreturn");

  const state = {
    student: "",
    pages: [],
    active: 0,
    drawings: {},       // page_index -> [{type:"stroke"|"text"|"shape", ...}]
    tool: "pen",        // "pen" | "text" | "shape" | "eraser"
    shape: "rect",      // "rect" | "ellipse" | "line" | "arrow"
    drawing: false,
    currentStroke: null,
    currentShape: null, // shape preview while dragging
    pendingPoint: null, // {x, y} for the text input
    textInput: null,    // inline text input element
    editingText: null,  // text item being edited (null = creating new)
    redoStack: [],      // undone items for redo: [{page, item}]
    busy: false,
    aiIndex: 0,         // current item within the AI review queue
    gradingStatus: "",  // "" = editing, "returned" = sent back to student
  };

  // ---------- Data ----------
  async function loadGrading() {
    const params = new URLSearchParams(window.location.search);
    state.student = params.get("student") || "";
    const data = await App.api(
      "/api/homework/" + homeworkId + "/grading?student=" + encodeURIComponent(state.student)
    );
    titleEl.textContent = "批改 · " + state.student;
    metaEl.replaceChildren();
    const chip = document.createElement("span");
    chip.className = "hw-meta-chip";
    chip.textContent = data.homework.title;
    metaEl.appendChild(chip);
    const pagesChip = document.createElement("span");
    pagesChip.className = "hw-meta-chip";
    pagesChip.textContent = "提交 " + data.submission_pages.length + " 页";
    metaEl.appendChild(pagesChip);
    backLink.href = "/homework/" + homeworkId;
    backLink.textContent = "← 返回作业";
    state.pages = data.submission_pages || [];
    state.drawings = data.drawings || {};
    state.gradingStatus = data.grading_status || "";
    pageRangeStart.value = "1";
    pageRangeEnd.value = String(state.pages.length);
    pageRangeEnd.max = String(state.pages.length);
    state.active = 0;
    renderAnswerThumbs(data.answer_pages || []);
    render();
    renderAiPanel();
    renderGradingStatus();
  }

  function renderAnswerThumbs(pages) {
    answerThumbs.replaceChildren();
    if (!pages.length) {
      const p = document.createElement("p");
      p.className = "muted";
      p.textContent = "老师暂未上传标准答案。";
      answerThumbs.appendChild(p);
      return;
    }
    pages.forEach(function (page) {
      const img = document.createElement("img");
      img.src = page.image_url || ("/uploads/" + page.image_filename);
      img.alt = "标准答案";
      img.className = "answer-thumb";
      img.title = "点击放大查看";
      img.addEventListener("click", function () {
        window.open(img.src, "_blank");
      });
      answerThumbs.appendChild(img);
    });
  }

  // ---------- Rendering ----------
  function render() {
    renderAiPanel();
    const total = state.pages.length;
    indicator.textContent = total ? (state.active + 1) + " / " + total : "0 / 0";
    prevBtn.disabled = state.active <= 0;
    nextBtn.disabled = total === 0 || state.active >= total - 1;
    toolPen.classList.toggle("active", state.tool === "pen");
    toolText.classList.toggle("active", state.tool === "text");
    toolShape.classList.toggle("active", state.tool === "shape");
    toolEraser.classList.toggle("active", state.tool === "eraser");
    shapeGroup.hidden = state.tool !== "shape";
    stage.classList.toggle("mark-mode", state.tool !== "pen");

    const page = state.pages[state.active];
    if (!page) {
      image.hidden = true;
      canvas.hidden = true;
      emptyEl.hidden = false;
      return;
    }
    emptyEl.hidden = true;
    image.hidden = false;
    canvas.hidden = false;
    const src = page.image_url || ("/uploads/" + page.image_filename);
    if (image.getAttribute("src") !== src) {
      // Page switch: clear stale strokes right away, then redraw only after
      // the new image has loaded — otherwise strokes are laid out against the
      // previous page's dimensions and appear shifted.
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      image.onload = function () { resizeCanvas(); };
      image.src = src;
      if (image.complete) resizeCanvas(); // cached image: draw immediately
    } else if (image.complete) {
      resizeCanvas();
    } else {
      image.onload = function () { resizeCanvas(); };
    }
  }

  function resizeCanvas() {
    // Use the image's natural pixel size as the canvas coordinate system and
    // stretch it over the stage with CSS. Annotation coordinates are page
    // fractions, so they map correctly regardless of layout/display timing.
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    if (!width || !height) return;
    canvas.width = width;
    canvas.height = height;
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.getContext("2d").setTransform(1, 0, 0, 1, 0, 0);
    redraw();
  }

  function redraw() {
    const ctx = canvas.getContext("2d");
    // The canvas backing store is the image's natural size (no DPR scaling),
    // so clear the full backing store.
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    (state.drawings[state.active] || []).forEach(drawItem);
    if (state.currentStroke) drawItem(state.currentStroke);
    if (state.currentShape) drawItem(state.currentShape);
    // Highlight the AI annotation currently under review (if on this page).
    const entry = currentAiEntry();
    if (entry && entry.page === state.active) highlightAiItem(ctx, entry.item);
  }

  // Dashed orange ring around the AI item currently shown in the AI card.
  function highlightAiItem(ctx, item) {
    const w = canvas.width;
    const h = canvas.height;
    let x1, y1, x2, y2;
    if (item.type === "text") {
      x1 = item.x * w; y1 = item.y * h;
      ctx.font = "bold 16px sans-serif";
      const textWidth = Math.max(60, ctx.measureText(String(item.text || "")).width);
      x2 = x1 + textWidth + 8;
      y2 = y1 + 24;
    } else {
      x1 = item.x1 * w; y1 = item.y1 * h;
      x2 = item.x2 * w; y2 = item.y2 * h;
    }
    const pad = 8;
    const left = Math.min(x1, x2) - pad;
    const top = Math.min(y1, y2) - pad;
    const boxW = Math.abs(x2 - x1) + pad * 2;
    const boxH = Math.abs(y2 - y1) + pad * 2;
    ctx.save();
    ctx.strokeStyle = "#ffb300";
    ctx.lineWidth = 3;
    ctx.setLineDash([7, 5]);
    ctx.strokeRect(left, top, boxW, boxH);
    ctx.restore();
  }

  // Dispatch drawing by item type via the shared GradingDraw module.
  function drawItem(item) {
    if (!item) return;
    const ctx = canvas.getContext("2d");
    GradingDraw.drawItem(ctx, item, canvas.width, canvas.height);
  }

  // ---------- Drawing (Apple Pencil / touch / mouse via Pointer Events) ----------
  function canvasPoint(event) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
    };
  }

  // ---------- Hit testing (eraser / text editing) ----------
  function itemBBox(item, w, h) {
    if (item.type === "text") {
      const ctx = canvas.getContext("2d");
      ctx.font = "bold 16px sans-serif";
      const width = Math.max(60, ctx.measureText(String(item.text || "")).width);
      return { x1: item.x * w, y1: item.y * h, x2: item.x * w + width, y2: item.y * h + 24 };
    }
    if (item.type === "shape") {
      return { x1: item.x1 * w, y1: item.y1 * h, x2: item.x2 * w, y2: item.y2 * h };
    }
    // Stroke: bbox of its points.
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    (item.points || []).forEach(function (point) {
      x1 = Math.min(x1, point[0] * w); y1 = Math.min(y1, point[1] * h);
      x2 = Math.max(x2, point[0] * w); y2 = Math.max(y2, point[1] * h);
    });
    return { x1: x1, y1: y1, x2: x2, y2: y2 };
  }

  function hitTest(point) {
    // Return {page, index, item} of the topmost annotation under the click.
    const w = canvas.width;
    const h = canvas.height;
    const px = point.x * w;
    const py = point.y * h;
    const tolerance = 10;
    const strokes = state.drawings[state.active] || [];
    for (let index = strokes.length - 1; index >= 0; index -= 1) {
      const item = strokes[index];
      const box = itemBBox(item, w, h);
      const left = Math.min(box.x1, box.x2) - tolerance;
      const right = Math.max(box.x1, box.x2) + tolerance;
      const top = Math.min(box.y1, box.y2) - tolerance;
      const bottom = Math.max(box.y1, box.y2) + tolerance;
      if (px >= left && px <= right && py >= top && py <= bottom) {
        return { index: index, item: item };
      }
    }
    return null;
  }

  async function eraseAt(point) {
    const hit = hitTest(point);
    if (!hit) return;
    const strokes = state.drawings[state.active] || [];
    strokes.splice(hit.index, 1);
    state.redoStack = [];
    redraw();
    renderAiPanel();
    await saveDrawings();
  }

  canvas.addEventListener("pointerdown", function (event) {
    if (!state.pages.length) return;
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    const point = canvasPoint(event);
    if (state.tool === "pen") {
      state.drawing = true;
      // Apple Pencil reports pressure: scale the stroke width with it.
      const pressure = event.pointerType === "pen" ? (event.pressure || 0.5) * 6 : 3;
      state.currentStroke = {
        type: "stroke",
        color: penColor.value,
        width: Math.max(1.5, pressure),
        points: [[point.x, point.y]],
      };
      redraw();
    } else if (state.tool === "text") {
      // Clicking an existing text annotation edits it; empty space creates one.
      const hit = hitTest(point);
      if (hit && hit.item.type === "text") {
        openTextInput(point, hit.item);
      } else {
        openTextInput(point, null);
      }
    } else if (state.tool === "eraser") {
      eraseAt(point);
    } else {
      state.drawing = true;
      state.currentShape = {
        type: "shape",
        shape: state.shape,
        color: penColor.value,
        width: 3,
        x1: point.x, y1: point.y,
        x2: point.x, y2: point.y,
      };
      redraw();
    }
  });

  canvas.addEventListener("pointermove", function (event) {
    if (!state.drawing) return;
    event.preventDefault();
    const point = canvasPoint(event);
    if (state.currentStroke) {
      state.currentStroke.points.push([point.x, point.y]);
    } else if (state.currentShape) {
      state.currentShape.x2 = point.x;
      state.currentShape.y2 = point.y;
    } else {
      return;
    }
    redraw();
  });

  function finishStroke() {
    if (!state.drawing) return;
    state.drawing = false;
    const strokes = state.drawings[state.active] || (state.drawings[state.active] = []);
    if (state.currentStroke) {
      const stroke = state.currentStroke;
      state.currentStroke = null;
      if (stroke.points.length < 2) { redraw(); return; }
      state.redoStack = [];
      strokes.push(stroke);
    } else if (state.currentShape) {
      const shape = state.currentShape;
      state.currentShape = null;
      // Ignore tiny accidental drags.
      if (Math.abs(shape.x2 - shape.x1) < 0.005 &&
          Math.abs(shape.y2 - shape.y1) < 0.005) { redraw(); return; }
      state.redoStack = [];
      strokes.push(shape);
    }
    redraw();
    saveDrawings();
  }

  canvas.addEventListener("pointerup", finishStroke);
  canvas.addEventListener("pointercancel", finishStroke);
  window.addEventListener("resize", function () {
    if (state.pages.length && !image.hidden) resizeCanvas();
  });

  async function saveDrawings(pageIndex) {
    const target = typeof pageIndex === "number" ? pageIndex : state.active;
    try {
      await App.apiJson(
        "/api/homework/" + homeworkId + "/grading/drawings", "PUT",
        { student: state.student, page_index: target, strokes: state.drawings[target] || [] }
      );
    } catch (error) {
      App.showToast(error.message, "error");
    }
  }

  undoBtn.addEventListener("click", function () {
    const strokes = state.drawings[state.active] || [];
    if (!strokes.length) return;
    const item = strokes.pop();
    state.redoStack.push({ page: state.active, item: item });
    redraw();
    renderAiPanel();
    saveDrawings();
  });

  redoBtn.addEventListener("click", function () {
    const entry = state.redoStack.pop();
    if (!entry) return;
    const strokes = state.drawings[entry.page] || (state.drawings[entry.page] = []);
    strokes.push(entry.item);
    state.active = entry.page;
    render();
    saveDrawings(entry.page);
  });

  // Keyboard shortcuts: Ctrl+Z undo, Ctrl+Y / Ctrl+Shift+Z redo.
  document.addEventListener("keydown", function (event) {
    if (!(event.ctrlKey || event.metaKey)) return;
    // Don't hijack shortcuts while typing in the inline text input.
    if (state.textInput) return;
    const key = (event.key || "").toLowerCase();
    if (key === "z" && !event.shiftKey) {
      event.preventDefault();
      undoBtn.click();
    } else if (key === "y" || (key === "z" && event.shiftKey)) {
      event.preventDefault();
      redoBtn.click();
    }
  });

  // ---------- Text tool: inline input on the page ----------
  function openTextInput(point, existing) {
    closeTextInput(true);
    state.pendingPoint = point;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "grade-text-input";
    input.placeholder = existing ? "修改文字，回车确认" : "输入批注文字，回车确认";
    input.maxLength = 200;
    input.value = existing ? (existing.text || "") : "";
    input.style.left = (point.x * 100) + "%";
    input.style.top = (point.y * 100) + "%";
    input.style.color = existing ? existing.color : penColor.value;
    stage.appendChild(input);
    state.textInput = input;
    state.editingText = existing || null;
    input.focus();
    input.select();
    input.addEventListener("keydown", function (event) {
      if (event.key === "Enter") { event.preventDefault(); closeTextInput(false); }
      if (event.key === "Escape") { event.preventDefault(); closeTextInput(true); }
    });
    input.addEventListener("blur", function () { closeTextInput(false); });
  }

  function closeTextInput(cancel) {
    const input = state.textInput;
    if (!input) return;
    state.textInput = null;
    const value = input.value.trim();
    input.remove();
    const editing = state.editingText;
    state.editingText = null;
    if (cancel || !state.pendingPoint) return;
    if (editing) {
      // Update the existing text annotation (empty text removes it).
      const strokes = state.drawings[state.active] || [];
      const at = strokes.indexOf(editing);
      if (at !== -1) {
        if (value) {
          editing.text = value;
          editing.color = penColor.value;
        } else {
          strokes.splice(at, 1);
        }
        state.redoStack = [];
      }
      redraw();
      renderAiPanel();
      saveDrawings();
      state.pendingPoint = null;
      return;
    }
    if (!value) { state.pendingPoint = null; return; }
    const strokes = state.drawings[state.active] || (state.drawings[state.active] = []);
    state.redoStack = [];
    strokes.push({
      type: "text",
      x: state.pendingPoint.x,
      y: state.pendingPoint.y,
      color: penColor.value,
      text: value,
    });
    state.pendingPoint = null;
    redraw();
    saveDrawings();
  }

  // ---------- Tool selection ----------
  function selectTool(tool) {
    closeTextInput(true);
    state.tool = tool;
    render();
  }
  toolPen.addEventListener("click", function () { selectTool("pen"); });
  toolText.addEventListener("click", function () { selectTool("text"); });
  toolShape.addEventListener("click", function () { selectTool("shape"); });
  toolEraser.addEventListener("click", function () { selectTool("eraser"); });
  shapeGroup.querySelectorAll(".shape-btn").forEach(function (button) {
    button.addEventListener("click", function () {
      state.shape = button.dataset.shape;
      shapeGroup.querySelectorAll(".shape-btn").forEach(function (other) {
        other.classList.toggle("active", other === button);
      });
    });
  });

  // ---------- Navigation ----------
  prevBtn.addEventListener("click", function () {
    if (state.active > 0) { state.active -= 1; render(); }
  });
  nextBtn.addEventListener("click", function () {
    if (state.active < state.pages.length - 1) { state.active += 1; render(); }
  });

  // ---------- AI 标注区：逐条确认 AI 绘制的批注 ----------
  const AI_SHAPE_GLYPH = {
    tick: "✔", cross: "✘", rect: "▭", ellipse: "⬭",
    line: "╱", arrow: "↗",
  };

  function aiItems() {
    // Collect all AI-generated drawing items with their location.
    const items = [];
    Object.keys(state.drawings).forEach(function (pageIndex) {
      (state.drawings[pageIndex] || []).forEach(function (item, index) {
        if (item.source === "ai") items.push({ page: Number(pageIndex), index: index, item: item });
      });
    });
    return items;
  }

  function currentAiEntry() {
    const items = aiItems();
    return items[state.aiIndex] || null;
  }

  function describeAiItem(item) {
    if (item.type === "text") return { verdict: "AI 文字批注", cls: "note", text: item.text || "" };
    const glyph = AI_SHAPE_GLYPH[item.shape] || "⬡";
    const label = item.shape === "tick" ? "AI 判定：✔ 正确"
      : item.shape === "cross" ? "AI 判定：✘ 错误"
      : "AI " + glyph + " 圈画/图形";
    const cls = item.shape === "tick" ? "tick"
      : item.shape === "cross" ? "cross" : "note";
    return { verdict: label, cls: cls, text: "" };
  }

  function renderAiPanel() {
    if (state.busy) {
      // While the AI is running, the card shows the batch progress bar.
      aiCard.hidden = false;
      aiProgress.hidden = false;
      aiCompact.hidden = true;
      return;
    }
    aiProgress.hidden = true;
    const items = aiItems();
    if (!items.length) {
      aiCard.hidden = true;
      return;
    }
    aiCard.hidden = false;
    aiCompact.hidden = false;
    const entry = items[state.aiIndex];
    if (!entry) {
      aiCounter.textContent = "完成";
      aiVerdict.className = "ai-verdict done";
      aiVerdict.textContent = "✅ 全部 AI 批注已确认";
      aiText.textContent = "所有 AI 批注均已处理，可继续手动批注。";
      aiPrev.disabled = true;
      aiNext.disabled = true;
      aiTick.disabled = true;
      aiCross.disabled = true;
      return;
    }
    aiCounter.textContent = (state.aiIndex + 1) + " / " + items.length;
    const info = describeAiItem(entry.item);
    aiVerdict.className = "ai-verdict " + info.cls;
    aiVerdict.textContent = info.verdict;
    aiText.textContent = info.text || "（第 " + (entry.page + 1) + " 页，已在图上高亮显示）";
    aiPrev.disabled = state.aiIndex <= 0;
    aiNext.disabled = state.aiIndex >= items.length - 1;
    aiTick.disabled = false;
    aiCross.disabled = false;
  }

  function gotoAiIndex(index) {
    const items = aiItems();
    if (!items.length) {
      // Queue empty: still redraw so any leftover highlight is cleared.
      renderAiPanel();
      render();
      return;
    }
    state.aiIndex = Math.min(Math.max(0, index), items.length - 1);
    const entry = items[state.aiIndex];
    if (entry && entry.page !== state.active) state.active = entry.page;
    render();
    scrollToAiItem(entry);
  }

  // Scroll so the highlighted AI annotation sits in the middle of the view;
  // centering is more accurate than jumping to the page top on tall pages.
  function scrollToAiItem(entry) {
    if (!entry) return;
    const doScroll = function () {
      const item = entry.item;
      const rect = stage.getBoundingClientRect();
      const stageTop = rect.top + window.scrollY;
      let yFrac;
      if (item.type === "text") {
        yFrac = item.y;
      } else {
        yFrac = (item.y1 + item.y2) / 2;
      }
      const imageHeight = image.clientHeight || image.naturalHeight || 0;
      const targetY = stageTop + yFrac * imageHeight;
      window.scrollTo({
        top: Math.max(0, targetY - window.innerHeight / 2),
        behavior: "smooth",
      });
    };
    if (image.complete) {
      doScroll();
    } else {
      // Wait for the switched page image to load before measuring.
      const previousOnload = image.onload;
      image.onload = function () {
        if (typeof previousOnload === "function") previousOnload();
        doScroll();
      };
    }
  }

  async function confirmAiItem(keep) {
    const items = aiItems();
    const entry = items[state.aiIndex];
    if (!entry) return;
    const strokes = state.drawings[entry.page] || [];
    const at = strokes.indexOf(entry.item);
    if (at !== -1) {
      if (keep) {
        // Accepted: it becomes a normal teacher drawing and leaves the queue.
        delete strokes[at].source;
      } else {
        strokes.splice(at, 1);
      }
    }
    // Clamp to the queue after removal, then auto-locate the next item.
    const remaining = aiItems().length;
    if (state.aiIndex >= remaining) state.aiIndex = Math.max(0, remaining - 1);
    gotoAiIndex(state.aiIndex);
    await saveDrawings(entry.page);
    App.showToast(keep ? "已保留该 AI 批注。" : "已删除该 AI 批注。");
  }

  aiTick.addEventListener("click", function () { confirmAiItem(true); });
  aiCross.addEventListener("click", function () { confirmAiItem(false); });
  aiPrev.addEventListener("click", function () { gotoAiIndex(state.aiIndex - 1); });
  aiNext.addEventListener("click", function () { gotoAiIndex(state.aiIndex + 1); });
  // Dropdown: expand/collapse the detail (verdict + comment + hint).
  aiToggle.addEventListener("click", function () {
    aiDetail.hidden = !aiDetail.hidden;
    aiToggle.textContent = aiDetail.hidden ? "▾" : "▴";
  });

  // ---------- 保存 / 舍弃 / 发还 ----------
  function renderGradingStatus() {
    const returned = state.gradingStatus === "returned";
    gradingStatus.hidden = false;
    gradingStatus.textContent = returned ? "已发还" : "批改中";
    gradingStatus.className = "badge " + (returned ? "badge-returned" : "badge-muted");
    gradingReturn.hidden = returned;
    gradingUnreturn.hidden = !returned;
  }

  gradingSave.addEventListener("click", async function () {
    try {
      const pages = Object.keys(state.drawings);
      for (const pageIndex of pages) {
        await saveDrawings(Number(pageIndex));
      }
      App.showToast("批改已保存。");
    } catch (error) {
      App.showToast(error.message, "error");
    }
  });

  gradingDiscard.addEventListener("click", async function () {
    const ok = await App.confirmDialog({
      title: "舍弃保存",
      message: "确认舍弃该学生的全部批改批注吗？此操作不可恢复。",
      confirmText: "确认舍弃",
      cancelText: "暂不舍弃",
    });
    if (!ok) return;
    try {
      await App.apiJson(
        "/api/homework/" + homeworkId + "/grading/discard", "POST",
        { student: state.student }
      );
      state.drawings = {};
      state.redoStack = [];
      state.aiIndex = 0;
      redraw();
      renderAiPanel();
      App.showToast("已舍弃全部批改批注。");
    } catch (error) {
      App.showToast(error.message, "error");
    }
  });

  gradingReturn.addEventListener("click", async function () {
    const ok = await App.confirmDialog({
      title: "发还批改作业",
      message: "确认将批改结果发还给 " + state.student + " 吗？发还后学生即可查看批注。",
      confirmText: "确认发还",
      cancelText: "暂不发还",
    });
    if (!ok) return;
    try {
      const data = await App.apiJson(
        "/api/homework/" + homeworkId + "/grading/return", "POST",
        { student: state.student, returned: true }
      );
      state.gradingStatus = data.grading_status || "returned";
      renderGradingStatus();
      App.showToast("批改作业已发还给学生。");
    } catch (error) {
      App.showToast(error.message, "error");
    }
  });

  gradingUnreturn.addEventListener("click", async function () {
    const ok = await App.confirmDialog({
      title: "取消发还",
      message: "确认取消发还吗？取消后学生将不再看到批改结果，你可继续修改。",
      confirmText: "确认取消",
      cancelText: "暂不取消",
    });
    if (!ok) return;
    try {
      const data = await App.apiJson(
        "/api/homework/" + homeworkId + "/grading/return", "POST",
        { student: state.student, returned: false }
      );
      state.gradingStatus = data.grading_status || "";
      renderGradingStatus();
      App.showToast("已取消发还，可继续修改批注。");
    } catch (error) {
      App.showToast(error.message, "error");
    }
  });

  // ---------- AI assist: draw shapes and text directly on the pages ----------
  // One page per AI conversation (reliable page mapping), but several pages
  // run concurrently so multi-page grading stays fast.
  const AI_CONCURRENCY = 3;
  function validatePageRange() {
    const total = state.pages.length;
    const startRaw = (pageRangeStart.value || "").trim();
    const endRaw = (pageRangeEnd.value || "").trim();
    const start = parseInt(startRaw, 10);
    const end = parseInt(endRaw, 10);
    const invalid = function (message) {
      App.showToast(message, "error");
      pageRangeStart.classList.add("range-error");
      pageRangeEnd.classList.add("range-error");
      setTimeout(function () {
        pageRangeStart.classList.remove("range-error");
        pageRangeEnd.classList.remove("range-error");
      }, 2000);
      return null;
    };
    if (!startRaw || !endRaw || isNaN(start) || isNaN(end) ||
        start < 1 || end < 1 || start > total || end > total) {
      return invalid("页码范围无效：请输入 1 – " + total + " 之间的页码。");
    }
    if (start > end) {
      return invalid("页码范围无效：起始页不能大于结束页。");
    }
    pageRangeStart.classList.remove("range-error");
    pageRangeEnd.classList.remove("range-error");
    return { start: start, end: end };
  }

  aiButton.addEventListener("click", async function () {
    if (state.busy) return;
    if (!state.pages.length) {
      App.showToast("该学生还没有提交作业页面。", "error");
      return;
    }
    const range = validatePageRange();
    if (!range) return;
    const start = range.start;
    const end = range.end;
    const rangePages = end - start + 1;
    const pageList = [];
    for (let page = start; page <= end; page += 1) pageList.push(page);

    state.busy = true;
    aiButton.disabled = true;
    aiButton.classList.add("ai-thinking");
    aiButton.title = "AI 正在思考与批改…";
    renderAiPanel();
    let completed = 0;
    let totalDrawn = 0;
    let firstError = null;
    let cursor = 0;

    const updateProgress = function () {
      aiProgressFill.style.width = Math.round((completed / rangePages) * 100) + "%";
      aiProgressText.textContent = "🤖 已处理 " + completed + " / " + rangePages + " 页";
    };

    const gradePage = async function (pageIndex) {
      try {
        const data = await App.apiJson(
          "/api/homework/" + homeworkId + "/grading/ai", "POST",
          { student: state.student, page_start: pageIndex, page_end: pageIndex }
        );
        const drawings = data.drawings || {};
        Object.keys(drawings).forEach(function (key) {
          const items = drawings[key] || [];
          if (!items.length) return;
          const strokes = state.drawings[key] || (state.drawings[key] = []);
          strokes.push.apply(strokes, items);
          state.redoStack = [];
          totalDrawn += items.length;
        });
        redraw();
        // Keep the progress bar visible while other pages are still running.
        aiProgress.hidden = false;
        aiCompact.hidden = true;
      } catch (error) {
        if (!firstError) firstError = error.message;
      } finally {
        completed += 1;
        updateProgress();
      }
    };

    try {
      const worker = async function () {
        while (cursor < pageList.length) {
          const pageIndex = pageList[cursor];
          cursor += 1;
          await gradePage(pageIndex);
        }
      };
      const workers = [];
      for (let i = 0; i < Math.min(AI_CONCURRENCY, pageList.length); i += 1) {
        workers.push(worker());
      }
      await Promise.all(workers);

      if (totalDrawn) {
        // Start the one-by-one review from the first AI annotation.
        state.aiIndex = 0;
        gotoAiIndex(0);
        App.showToast("AI 已绘制 " + totalDrawn + " 处批注，从第 1 条开始逐条确认。" +
          (firstError ? "（部分页面失败：" + firstError + "）" : ""));
      } else if (firstError) {
        App.showToast("AI 批改失败：" + firstError, "error");
      } else {
        App.showToast("AI 未找到可批注的答案。");
      }
    } finally {
      state.busy = false;
      aiButton.disabled = false;
      aiButton.textContent = "🤖";
      aiButton.title = "AI 辅助批改";
      aiButton.classList.remove("ai-thinking");
      renderAiPanel();
    }
  });

  // ---------- Init ----------
  (async function init() {
    try {
      await App.loadMe();
      await loadGrading();
    } catch (error) {
      App.showToast(error.message, "error");
      titleEl.textContent = "批改";
    }
  })();
})(window.App);

