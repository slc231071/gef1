"use strict";

// Reusable multi-page scanning widget shared by the teacher and student ends.
// It builds its whole UI inside the given mount element.
window.Converter = (function () {
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function createScanner(mount, options) {
    const ctx = {
      mount: mount,
      homeworkId: options.homeworkId,
      kind: options.kind,
      readOnly: !!options.readOnly,
      allOwners: !!options.allOwners,
      ownerFilter: options.ownerFilter || null,
      confirmSubmit: !!options.confirmSubmit,
      // Status used by save(): students save a draft first, the answer is final.
      saveStatus: options.saveStatus === "draft" ? "draft" : "submitted",
      hideSaveButton: !!options.hideSaveButton,
      enableCamera: !!options.enableCamera,
      cameraFacing: "environment",
      onChange: typeof options.onChange === "function" ? options.onChange : null,
      pages: [],
      active: 0,
      dirty: false,
      busy: false,
      submitted: false,
    };
    build(ctx);
    bind(ctx);
    return {
      load: function () { return reload(ctx); },
      refresh: function () { render(ctx); },
      getPages: function () { return ctx.pages; },
      // Re-target a read-only viewer at a specific owner (e.g. a student).
      setOwner: function (name) { ctx.ownerFilter = name || null; return reload(ctx); },
      // Persist directly using the scanner's default status (draft for students,
      // final for the standard answer).
      save: function () { return save(ctx); },
      // Student flow: confirm (if enabled) then persist as a finished submission.
      submit: function () { return requestSubmit(ctx); },
      getMeta: function () { return getMeta(ctx); },
      // Release the camera when the surrounding popup closes.
      stopCamera: function () { stopCamera(ctx); },
    };
  }

  function getMeta(ctx) {
    return {
      pageCount: ctx.pages.length,
      dirty: !!ctx.dirty,
      busy: !!ctx.busy,
      readOnly: !!ctx.readOnly,
      status: ctx.submitted ? "submitted" : "draft",
    };
  }

  function build(ctx) {
    const root = el("div", "scanner");
    // Hidden file input: dragging onto the dropzone, clicking the dropzone and
    // the page-strip "+" button all funnel through this element.
    if (!ctx.readOnly) {
      const input = el("input");
      input.type = "file";
      input.accept = "image/png,image/jpeg,image/gif,image/webp,image/bmp,image/tiff";
      input.multiple = true;
      input.hidden = true;
      ctx.fileInput = input;

      const dropzone = el("label", "dropzone");
      dropzone.appendChild(el("span", "dropzone-icon", "⬆"));
      dropzone.appendChild(el("strong", "", "拖拽图片到这里，或点击选择"));
      dropzone.appendChild(el("span", "dropzone-hint", "支持连续多页扫描（PNG / JPG / WEBP / BMP / TIFF）"));
      dropzone.appendChild(input);
      root.appendChild(dropzone);
      ctx.dropzone = dropzone;

      if (ctx.enableCamera) appendCamera(ctx, root);
    }

    const toolbar = el("div", "scanner-toolbar");
    ctx.status = el("span", "scanner-status", ctx.readOnly ? "只读预览" : "");
    toolbar.appendChild(ctx.status);
    toolbar.appendChild(el("span", "spacer"));

    if (!ctx.readOnly && !ctx.hideSaveButton) {
      ctx.saveButton = el("button", "primary-button", ctx.saveStatus === "draft" ? "保存草稿" : "保存");
      ctx.saveButton.type = "button";
      ctx.saveButton.disabled = true;
      toolbar.appendChild(ctx.saveButton);
    }
    root.appendChild(toolbar);

    ctx.strip = el("div", "page-strip");
    root.appendChild(ctx.strip);
    const body = el("div", "scanner-body");
    const viewer = el("div", "page-viewer");
    const vhead = el("div", "page-viewer-header");
    ctx.prevButton = el("button", "", "上一页");
    ctx.prevButton.type = "button";
    ctx.indicator = el("span", "page-indicator", "0 / 0");
    ctx.nextButton = el("button", "", "下一页");
    ctx.nextButton.type = "button";
    vhead.appendChild(ctx.prevButton);
    vhead.appendChild(ctx.indicator);
    vhead.appendChild(ctx.nextButton);
    if (!ctx.readOnly) {
      ctx.deleteButton = el("button", "danger-text", "删除本页");
      ctx.deleteButton.type = "button";
      vhead.appendChild(ctx.deleteButton);
    }
    viewer.appendChild(vhead);
    ctx.imageWrap = el("div", "page-image-wrap");
    viewer.appendChild(ctx.imageWrap);
    body.appendChild(viewer);
    root.appendChild(body);
    ctx.mount.replaceChildren(root);
  }

  function markDirty(ctx) {
    ctx.dirty = true;
    if (ctx.saveButton) ctx.saveButton.disabled = ctx.busy;
  }

  function bind(ctx) {
    if (ctx.fileInput) {
      ctx.fileInput.addEventListener("change", function () {
        scanFiles(ctx, Array.prototype.slice.call(ctx.fileInput.files || []));
        ctx.fileInput.value = "";
      });
    }
    if (ctx.dropzone) {
      ["dragenter", "dragover"].forEach(function (type) {
        ctx.dropzone.addEventListener(type, function (event) {
          event.preventDefault();
          ctx.dropzone.classList.add("dragover");
        });
      });
      ["dragleave", "dragend", "drop"].forEach(function (type) {
        ctx.dropzone.addEventListener(type, function (event) {
          event.preventDefault();
          ctx.dropzone.classList.remove("dragover");
        });
      });
      ctx.dropzone.addEventListener("drop", function (event) {
        const files = Array.prototype.slice.call((event.dataTransfer && event.dataTransfer.files) || []);
        if (files.length) scanFiles(ctx, files);
      });
    }
    if (ctx.saveButton) ctx.saveButton.addEventListener("click", function () { save(ctx); });
    ctx.prevButton.addEventListener("click", function () { move(ctx, -1); });
    ctx.nextButton.addEventListener("click", function () { move(ctx, 1); });
    if (ctx.deleteButton) {
      ctx.deleteButton.addEventListener("click", function () { removeActive(ctx); });
    }
    if (!ctx.readOnly) {
      window.addEventListener("beforeunload", function (event) {
        if (!ctx.dirty) return undefined;
        event.preventDefault();
        event.returnValue = "";
        return "";
      });
    }
    if (ctx.cameraToggle) ctx.cameraToggle.addEventListener("click", function () { startCamera(ctx); });
    if (ctx.cameraShot) ctx.cameraShot.addEventListener("click", function () { captureFrame(ctx); });
    if (ctx.cameraStop) ctx.cameraStop.addEventListener("click", function () { stopCamera(ctx); });
    if (ctx.cameraSwitch) {
      ctx.cameraSwitch.addEventListener("click", function () {
        ctx.cameraFacing = ctx.cameraFacing === "environment" ? "user" : "environment";
        startCamera(ctx);
      });
    }
  }

  async function reload(ctx) {
    setStatus(ctx, "载入中…");
    App.mountSpinner(ctx.imageWrap, "载入页面…");
    try {
      const data = await App.api("/api/homework/" + ctx.homeworkId);
      const me = data.me.username;
      ctx.pages = (data.pages || []).filter(function (p) {
        if (p.kind !== ctx.kind) return false;
        if (ctx.ownerFilter) return p.owner === ctx.ownerFilter;
        return ctx.allOwners ? true : p.owner === me;
      });
      ctx.active = 0;
      ctx.dirty = false;
      ctx.submitted = ctx.pages.some(function (p) { return p.status === "submitted"; });
      render(ctx);
    } catch (error) {
      setStatus(ctx, error.message);
      App.showToast(error.message, "error");
    }
  }

  function setStatus(ctx, message) {
    if (ctx.status) ctx.status.textContent = message || "";
  }

  function render(ctx) {
    renderStrip(ctx);
    renderActive(ctx);
    if (ctx.saveButton) ctx.saveButton.disabled = !ctx.dirty || ctx.busy;
    if (ctx.onChange) ctx.onChange(getMeta(ctx));
  }

  function renderStrip(ctx) {
    ctx.strip.replaceChildren();
    ctx.pages.forEach(function (page, index) {
      const button = el("button", "thumb" + (index === ctx.active ? " active" : ""));
      button.type = "button";
      const img = el("img");
      img.src = page.image_url || ("/uploads/" + page.image_filename);
      img.alt = "第 " + (index + 1) + " 页";
      button.appendChild(img);
      const badge = el("span", "thumb-index", String(index + 1));
      if (ctx.allOwners && page.owner) badge.title = page.owner;
      button.appendChild(badge);
      button.addEventListener("click", function () { switchTo(ctx, index); });
      ctx.strip.appendChild(button);
    });
    if (!ctx.readOnly) {
      const add = el("button", "thumb add", "+");
      add.type = "button";
      add.title = "继续扫描下一页";
      add.addEventListener("click", function () { if (ctx.fileInput) ctx.fileInput.click(); });
      ctx.strip.appendChild(add);
    }
  }

  function renderActive(ctx) {
    const total = ctx.pages.length;
    ctx.indicator.textContent = total ? (ctx.active + 1) + " / " + total : "0 / 0";
    ctx.prevButton.disabled = ctx.active <= 0;
    ctx.nextButton.disabled = total === 0 || ctx.active >= total - 1;

    const page = ctx.pages[ctx.active];
    ctx.imageWrap.replaceChildren();
    if (page) {
      const img = el("img");
      img.src = page.image_url || ("/uploads/" + page.image_filename);
      img.alt = "第 " + (ctx.active + 1) + " 页";
      ctx.imageWrap.appendChild(img);
    } else {
      const empty = el("div", "empty-state");
      empty.appendChild(el("strong", "", ctx.readOnly ? "暂无内容" : "还没有扫描结果"));
      empty.appendChild(el("span", "", ctx.readOnly ? "该作业暂时没有可查看的页面。" : "点击「选择图片并扫描」开始。"));
      ctx.imageWrap.appendChild(empty);
    }
    if (ctx.deleteButton) ctx.deleteButton.disabled = !page;
  }

  // ---------- Camera capture ----------
  function appendCamera(ctx, root) {
    const bar = el("div", "camera-bar");
    ctx.cameraToggle = el("button", "secondary-button", "\uD83D\uDCF7 用摄像头拍照");
    ctx.cameraToggle.type = "button";
    bar.appendChild(ctx.cameraToggle);

    const panel = el("div", "camera-panel");
    panel.hidden = true;
    ctx.cameraVideo = el("video", "camera-video");
    ctx.cameraVideo.setAttribute("playsinline", "");
    ctx.cameraVideo.muted = true;
    ctx.cameraCanvas = el("canvas");
    ctx.cameraCanvas.hidden = true;
    const controls = el("div", "camera-controls");
    ctx.cameraShot = el("button", "primary-button", "抓拍");
    ctx.cameraShot.type = "button";
    ctx.cameraSwitch = el("button", "tool-button", "切换摄像头");
    ctx.cameraSwitch.type = "button";
    ctx.cameraStop = el("button", "tool-button", "关闭相机");
    ctx.cameraStop.type = "button";
    controls.append(ctx.cameraShot, ctx.cameraSwitch, ctx.cameraStop);
    panel.append(ctx.cameraVideo, ctx.cameraCanvas, controls);

    root.appendChild(bar);
    root.appendChild(panel);
    ctx.cameraPanel = panel;
  }

  async function startCamera(ctx) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      App.showToast("当前环境不支持摄像头，请改用「上传图片」或拖拽。", "error");
      return;
    }
    stopCamera(ctx);
    try {
      ctx.cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: ctx.cameraFacing },
        audio: false,
      });
      ctx.cameraVideo.srcObject = ctx.cameraStream;
      await ctx.cameraVideo.play();
      ctx.cameraPanel.hidden = false;
    } catch (_error) {
      App.showToast("无法访问摄像头（需在 https 或 localhost 下打开）。", "error");
      ctx.cameraPanel.hidden = true;
    }
  }

  function stopCamera(ctx) {
    if (ctx.cameraStream) {
      ctx.cameraStream.getTracks().forEach(function (track) { track.stop(); });
      ctx.cameraStream = null;
    }
    if (ctx.cameraPanel) ctx.cameraPanel.hidden = true;
  }

  async function captureFrame(ctx) {
    const video = ctx.cameraVideo;
    if (!video || !video.videoWidth) return;
    const canvas = ctx.cameraCanvas;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0);
    const blob = await new Promise(function (resolve) { canvas.toBlob(resolve, "image/png"); });
    if (!blob) return;
    const file = new File([blob], "camera-" + Date.now() + ".png", { type: "image/png" });
    await scanFiles(ctx, [file]);
  }

  function switchTo(ctx, index) {
    ctx.active = index;
    render(ctx);
  }

  function move(ctx, delta) {
    const total = ctx.pages.length;
    if (!total) return;
    ctx.active = Math.max(0, Math.min(total - 1, ctx.active + delta));
    render(ctx);
  }

  function removeActive(ctx) {
    if (ctx.readOnly || !ctx.pages.length) return;
    ctx.pages.splice(ctx.active, 1);
    if (ctx.active >= ctx.pages.length) ctx.active = ctx.pages.length - 1;
    if (ctx.active < 0) ctx.active = 0;
    ctx.dirty = true;
    render(ctx);
  }

  async function scanFiles(ctx, files) {
    if (!files.length) return;
    ctx.busy = true;
    render(ctx);
    let done = 0;
    for (const file of files) {
      setStatus(ctx, "正在扫描 " + (done + 1) + " / " + files.length + " …");
      const form = new FormData();
      form.append("image", file);
      try {
        const data = await App.api("/api/convert", { method: "POST", body: form });
        ctx.pages.push({
          id: null,
          image_filename: data.page.image_filename,
          original_filename: data.page.original_filename,
          image_url: "/uploads/" + data.page.image_filename,
        });
        ctx.active = ctx.pages.length - 1;
        ctx.dirty = true;
        done += 1;
        render(ctx);
      } catch (error) {
        App.showToast(error.message, "error");
        setStatus(ctx, error.message);
      }
    }
    ctx.busy = false;
    setStatus(ctx, done ? ("已扫描 " + done + " 页，记得点击保存。") : "");
    render(ctx);
  }

  // Student flow: confirm before submitting. The standard answer saves directly.
  async function requestSubmit(ctx) {
    if (ctx.readOnly) return;
    if (ctx.confirmSubmit) {
      const ok = await App.confirmDialog({
        title: "提交作业",
        message: "确认提交你保存的作业吗？提交后老师即可查看。如需修改，可选择「暂不提交」。",
        confirmText: "确认提交",
        cancelText: "暂不提交",
      });
      if (!ok) {
        setStatus(ctx, "尚未提交，可继续修改后再次提交。");
        return;
      }
    }
    return save(ctx, "submitted");
  }

  async function save(ctx, status) {
    if (ctx.readOnly) return;
    const target = status === "draft" || status === "submitted" ? status : ctx.saveStatus;
    ctx.busy = true;
    render(ctx);
    try {
      const body = {
        kind: ctx.kind,
        status: target,
        pages: ctx.pages.map(function (p) {
          return {
            id: p.id,
            image_filename: p.image_filename,
            original_filename: p.original_filename,
          };
        }),
      };
      const data = await App.apiJson("/api/homework/" + ctx.homeworkId + "/pages", "PUT", body);
      ctx.pages = data.pages;
      ctx.active = Math.min(ctx.active, Math.max(0, ctx.pages.length - 1));
      ctx.dirty = false;
      ctx.submitted = target === "submitted";
      if (target === "submitted") {
        setStatus(ctx, "已提交 " + ctx.pages.length + " 页。");
        App.showToast("作业已提交，老师即可查看。");
      } else {
        setStatus(ctx, "已保存草稿 " + ctx.pages.length + " 页。");
        App.showToast("草稿已保存，可稍后提交。");
      }
    } catch (error) {
      App.showToast(error.message, "error");
      setStatus(ctx, error.message);
    } finally {
      ctx.busy = false;
      render(ctx);
    }
  }

  return { createScanner: createScanner };
})();
