"use strict";

// Shared helpers for every page (login is server-rendered and does not need them).
window.App = (function () {
  async function readJson(response) {
    let payload;
    try {
      payload = await response.json();
    } catch (_error) {
      throw new Error("服务器返回了无效响应 (" + response.status + ")。");
    }
    if (!response.ok) throw new Error(payload.error || ("请求失败 (" + response.status + ")。"));
    return payload;
  }

  function api(url, options) {
    return fetch(url, options || {}).then(readJson);
  }

  function apiJson(url, method, body) {
    return api(url, {
      method: method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .split("&").join("&amp;")
      .split("<").join("&lt;")
      .split(">").join("&gt;")
      .split('"').join("&quot;");
  }

  let toastTimer = null;
  function showToast(message, type) {
    const el = document.getElementById("toast");
    if (!el) return;
    clearTimeout(toastTimer);
    el.textContent = message;
    el.classList.toggle("error", type === "error");
    el.hidden = false;
    if (type !== "error") {
      toastTimer = setTimeout(function () { el.hidden = true; }, 4000);
    }
  }

  async function loadMe() {
    const me = await api("/api/me");
    const slot = document.getElementById("current-user");
    if (slot) slot.textContent = me.username + " · " + (me.role === "teacher" ? "老师" : "学生");
    return me;
  }

  // Shared student-list renderer used by both dashboards.
  async function loadStudents(listEl, countEl) {
    const data = await api("/api/students");
    if (countEl) countEl.textContent = data.students.length + " 位学生";
    listEl.replaceChildren();
    if (!data.students.length) {
      const li = document.createElement("li");
      li.className = "muted";
      li.textContent = "暂无学生账户。";
      listEl.appendChild(li);
      return data.students;
    }
    for (const name of data.students) {
      const li = document.createElement("li");
      li.className = "student-item";
      const avatar = document.createElement("span");
      avatar.className = "avatar";
      avatar.textContent = name.slice(0, 1).toUpperCase();
      const label = document.createElement("span");
      label.textContent = name;
      li.appendChild(avatar);
      li.appendChild(label);
      listEl.appendChild(li);
    }
    return data.students;
  }

  return {
    readJson: readJson,
    api: api,
    apiJson: apiJson,
    escapeHtml: escapeHtml,
    showToast: showToast,
    loadMe: loadMe,
    loadStudents: loadStudents,
  };
})();

// ---------------------------------------------------------------------------
// UI refresh helpers (augment the shared App object).
// ---------------------------------------------------------------------------
(function (App) {
  // Enhanced toast: close button, success/error variants, aria-live friendly.
  let toastTimer = null;

  function hideToast() {
    const el = document.getElementById("toast");
    if (el) el.hidden = true;
    clearTimeout(toastTimer);
  }

  function showToast(message, type) {
    const el = document.getElementById("toast");
    if (!el) return;
    clearTimeout(toastTimer);
    el.classList.toggle("error", type === "error");
    el.replaceChildren();
    const text = document.createElement("span");
    text.className = "toast-text";
    text.style.flex = "1";
    text.textContent = message;
    const close = document.createElement("button");
    close.type = "button";
    close.className = "toast-close";
    close.setAttribute("aria-label", "关闭提示");
    close.textContent = "\u2715";
    close.addEventListener("click", hideToast);
    el.appendChild(text);
    el.appendChild(close);
    el.hidden = false;
    // Errors stay until dismissed; successes auto-hide.
    if (type !== "error") toastTimer = setTimeout(hideToast, 4500);
  }

  // Promise-based replacement for window.confirm, styled with the app theme.
  function confirmDialog(options) {
    options = options || {};
    return new Promise(function (resolve) {
      const backdrop = document.createElement("div");
      backdrop.className = "modal-backdrop";
      backdrop.setAttribute("role", "dialog");
      backdrop.setAttribute("aria-modal", "true");
      const modal = document.createElement("div");
      modal.className = "modal";
      const title = document.createElement("h3");
      title.id = "modal-title";
      title.textContent = options.title || "确认操作";
      const message = document.createElement("p");
      message.textContent = options.message || "";
      const actions = document.createElement("div");
      actions.className = "modal-actions";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "secondary-button";
      cancel.textContent = options.cancelText || "取消";
      const confirm = document.createElement("button");
      confirm.type = "button";
      confirm.className = options.danger ? "danger-button" : "primary-button";
      confirm.textContent = options.confirmText || "确定";
      backdrop.setAttribute("aria-labelledby", "modal-title");
      function close(result) {
        document.removeEventListener("keydown", onKey);
        backdrop.remove();
        resolve(result);
      }
      function onKey(event) {
        if (event.key === "Escape") close(false);
        if (event.key === "Enter") close(true);
      }
      cancel.addEventListener("click", function () { close(false); });
      confirm.addEventListener("click", function () { close(true); });
      backdrop.addEventListener("click", function (event) {
        if (event.target === backdrop) close(false);
      });
      document.addEventListener("keydown", onKey);
      actions.appendChild(cancel);
      actions.appendChild(confirm);
      modal.appendChild(title);
      modal.appendChild(message);
      modal.appendChild(actions);
      backdrop.appendChild(modal);
      document.body.appendChild(backdrop);
      confirm.focus();
    });
  }

  App.showToast = showToast;
  App.hideToast = hideToast;
  App.confirmDialog = confirmDialog;
})(window.App);


// Loading-state + list helpers.
(function (App) {
  function mountSpinner(target, label) {
    if (!target) return;
    const block = document.createElement("div");
    block.className = "loading-block";
    const spinner = document.createElement("div");
    spinner.className = "spinner";
    const text = document.createElement("span");
    text.textContent = label || "载入中…";
    block.appendChild(spinner);
    block.appendChild(text);
    target.replaceChildren(block);
  }

  function skeletonList(target, count) {
    if (!target) return;
    target.replaceChildren();
    const size = count || 3;
    for (let i = 0; i < size; i++) {
      const li = document.createElement("li");
      li.className = "skeleton card";
      li.setAttribute("aria-hidden", "true");
      target.appendChild(li);
    }
  }

  function emptyState(target, options) {
    options = options || {};
    if (!target) return;
    const wrap = document.createElement("div");
    wrap.className = "empty-state";
    const icon = document.createElement("div");
    icon.className = "empty-icon";
    icon.textContent = options.icon || "◧";
    const title = document.createElement("strong");
    title.textContent = options.title || "暂无内容";
    const hint = document.createElement("span");
    hint.className = "muted";
    hint.textContent = options.hint || "";
    wrap.appendChild(icon);
    wrap.appendChild(title);
    wrap.appendChild(hint);
    target.replaceChildren(wrap);
  }

  // Human-friendly relative time for ISO-ish timestamps from the server.
  function relativeTime(value) {
    if (!value) return "";
    let text = String(value).trim();
    if (text.includes(" ") && !text.includes("T")) text = text.replace(" ", "T");
    if (!/[Z+]/.test(text.slice(10))) text += "Z";
    const then = new Date(text);
    if (isNaN(then.getTime())) return String(value);
    const seconds = (Date.now() - then.getTime()) / 1000;
    if (seconds < 60) return "刚刚";
    if (seconds < 3600) return Math.floor(seconds / 60) + " 分钟前";
    if (seconds < 86400) return Math.floor(seconds / 3600) + " 小时前";
    if (seconds < 2592000) return Math.floor(seconds / 86400) + " 天前";
    return then.toLocaleDateString();
  }

  App.mountSpinner = mountSpinner;
  App.skeletonList = skeletonList;
  App.emptyState = emptyState;
  App.relativeTime = relativeTime;
})(window.App);


// ---------------------------------------------------------------------------
// Form dialog + clipboard helpers (used by classroom create / join / invite).
// ---------------------------------------------------------------------------
(function (App) {
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      try {
        const area = document.createElement("textarea");
        area.value = text;
        area.setAttribute("readonly", "");
        area.style.position = "absolute";
        area.style.left = "-9999px";
        document.body.appendChild(area);
        area.select();
        document.execCommand("copy");
        document.body.removeChild(area);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  }

  // A small promise-based form modal. Resolves to a values object or null.
  function formDialog(options) {
    options = options || {};
    const fields = options.fields || [];
    return new Promise(function (resolve) {
      const backdrop = document.createElement("div");
      backdrop.className = "modal-backdrop";
      backdrop.setAttribute("role", "dialog");
      backdrop.setAttribute("aria-modal", "true");
      const modal = document.createElement("div");
      modal.className = "modal";
      const titleId = "form-modal-title";
      backdrop.setAttribute("aria-labelledby", titleId);
      const title = document.createElement("h3");
      title.id = titleId;
      title.textContent = options.title || "请填写";
      modal.appendChild(title);
      if (options.message) {
        const message = document.createElement("p");
        message.textContent = options.message;
        modal.appendChild(message);
      }
      const form = document.createElement("form");
      form.className = "stack-form";
      form.noValidate = true;
      const inputs = {};
      fields.forEach(function (field) {
        const label = document.createElement("label");
        label.className = "field";
        const span = document.createElement("span");
        span.textContent = field.label || field.name;
        label.appendChild(span);
        let input;
        if (field.textarea) {
          input = document.createElement("textarea");
          input.rows = field.rows || 2;
        } else {
          input = document.createElement("input");
          input.type = field.type || "text";
        }
        input.name = field.name;
        input.className = "form-input";
        if (field.placeholder) input.placeholder = field.placeholder;
        if (field.value != null) input.value = field.value;
        if (field.maxlength) input.maxLength = field.maxlength;
        if (field.required) input.required = true;
        inputs[field.name] = input;
        label.appendChild(input);
        form.appendChild(label);
      });
      modal.appendChild(form);
      const actions = document.createElement("div");
      actions.className = "modal-actions";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "secondary-button";
      cancel.textContent = options.cancelText || "取消";
      const confirm = document.createElement("button");
      confirm.type = "button";
      confirm.className = "primary-button";
      confirm.textContent = options.submitText || "确定";
      function close(result) {
        document.removeEventListener("keydown", onKey);
        backdrop.remove();
        resolve(result);
      }
      function submit() {
        const values = {};
        for (const field of fields) {
          values[field.name] = (inputs[field.name].value || "").trim();
        }
        for (const field of fields) {
          if (field.required && !values[field.name]) {
            inputs[field.name].focus();
            App.showToast("请填写" + (field.label || field.name) + "。", "error");
            return;
          }
        }
        close(values);
      }
      function onKey(event) {
        if (event.key === "Escape") close(null);
      }
      cancel.addEventListener("click", function () { close(null); });
      confirm.addEventListener("click", submit);
      form.addEventListener("submit", function (event) { event.preventDefault(); submit(); });
      backdrop.addEventListener("click", function (event) {
        if (event.target === backdrop) close(null);
      });
      document.addEventListener("keydown", onKey);
      actions.appendChild(cancel);
      actions.appendChild(confirm);
      modal.appendChild(actions);
      backdrop.appendChild(modal);
      document.body.appendChild(backdrop);
      const firstField = fields[0] && inputs[fields[0].name];
      if (firstField) firstField.focus();
    });
  }

  App.copyText = copyText;
  App.formDialog = formDialog;
})(window.App);

