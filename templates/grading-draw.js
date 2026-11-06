"use strict";

// Shared canvas drawing for grading annotations (strokes / text / shapes),
// used by both the teacher grading page and the student graded-work view.
window.GradingDraw = (function () {
  function drawStroke(ctx, stroke, w, h) {
    if (!stroke.points || stroke.points.length < 2) return;
    ctx.strokeStyle = stroke.color || "#e02020";
    ctx.lineWidth = stroke.width || 3;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    stroke.points.forEach(function (point, index) {
      const x = point[0] * w;
      const y = point[1] * h;
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  function drawText(ctx, item, w, h) {
    if (!item.text) return;
    const x = item.x * w;
    const y = item.y * h;
    ctx.fillStyle = item.color || "#e02020";
    ctx.font = "bold 16px sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    // Wrap long comments so they are not truncated on the image.
    const maxWidth = Math.max(120, w - x - 12);
    const lines = [];
    let remaining = String(item.text);
    while (remaining && lines.length < 4) {
      if (ctx.measureText(remaining).width <= maxWidth) {
        lines.push(remaining);
        break;
      }
      let cut = remaining.length;
      while (cut > 1 && ctx.measureText(remaining.slice(0, cut)).width > maxWidth) {
        cut -= 1;
      }
      lines.push(remaining.slice(0, cut));
      remaining = remaining.slice(cut);
    }
    if (lines.length === 4 && remaining) lines[3] += "…";
    lines.forEach(function (line, index) {
      ctx.fillText(line, x, y + index * 20);
    });
  }

  function drawShape(ctx, item, w, h) {
    const x1 = item.x1 * w, y1 = item.y1 * h;
    const x2 = item.x2 * w, y2 = item.y2 * h;
    ctx.strokeStyle = item.color || "#e02020";
    ctx.lineWidth = item.width || 3;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (item.shape === "tick") {
      ctx.beginPath();
      ctx.moveTo(x1, y1 + (y2 - y1) * 0.55);
      ctx.lineTo(x1 + (x2 - x1) * 0.38, y2);
      ctx.lineTo(x2, y1);
      ctx.stroke();
      return;
    }
    if (item.shape === "cross") {
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.moveTo(x2, y1);
      ctx.lineTo(x1, y2);
      ctx.stroke();
      return;
    }
    ctx.beginPath();
    if (item.shape === "rect") {
      ctx.rect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
    } else if (item.shape === "ellipse") {
      ctx.ellipse((x1 + x2) / 2, (y1 + y2) / 2,
        Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2, 0, 0, Math.PI * 2);
    } else if (item.shape === "line" || item.shape === "arrow") {
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
    }
    ctx.stroke();
    if (item.shape === "arrow") {
      const angle = Math.atan2(y2 - y1, x2 - x1);
      const head = Math.max(10, (item.width || 3) * 4);
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - head * Math.cos(angle - Math.PI / 6),
                 y2 - head * Math.sin(angle - Math.PI / 6));
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - head * Math.cos(angle + Math.PI / 6),
                 y2 - head * Math.sin(angle + Math.PI / 6));
      ctx.stroke();
    }
  }

  // Draw one annotation item. Legacy strokes have no "type" field.
  function drawItem(ctx, item, w, h) {
    if (!item) return;
    if (item.type === "text") return drawText(ctx, item, w, h);
    if (item.type === "shape") return drawShape(ctx, item, w, h);
    drawStroke(ctx, item, w, h);
  }

  // Draw a whole list of items and fit the canvas to the given image.
  function drawAll(ctx, items, img) {
    const ratio = window.devicePixelRatio || 1;
    const width = img.clientWidth || img.naturalWidth;
    const height = img.clientHeight || img.naturalHeight;
    if (!width || !height) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    (items || []).forEach(function (item) { drawItem(ctx, item, width, height); });
  }

  return { drawItem: drawItem, drawAll: drawAll };
})();