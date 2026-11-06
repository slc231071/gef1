#!/usr/bin/env python3
"""Flask server for a homework scan / grading studio (images only, no OCR)."""
from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import mimetypes
import os
import secrets
import sqlite3
import uuid
from datetime import datetime, timezone
from functools import wraps
from pathlib import Path
from typing import Any

from flask import (
    Flask,
    abort,
    jsonify,
    redirect,
    render_template,
    request,
    send_from_directory,
    session,
    url_for,
)
from openai import OpenAI
from werkzeug.utils import secure_filename

BASE_DIR = Path(__file__).resolve().parent
TEMPLATES_DIR = BASE_DIR / "templates"
SECURE_DIR = BASE_DIR / "secure"
ACCOUNTS_PATH = SECURE_DIR / "accounts.json"
UPLOAD_DIR = BASE_DIR / "uploads"
DATABASE_PATH = BASE_DIR / "markdown.db"
ALLOWED_EXTENSIONS = {"png", "jpg", "jpeg", "gif", "webp", "bmp", "tiff"}
PAGE_KINDS = {"answer", "submission"}
SECRET_KEY = os.environ.get("SCAN_SECRET_KEY", "scan-studio-dev-secret-change-me")
API_KEY = "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"
API_BASE = "https://integrate.api.nvidia.com/v1"
MODEL = "z-ai/glm-5.3-flash"

# Prompt for the AI-assisted grading feature. The model looks at the student's
# page images (plus the standard answer images when available) and returns
# drawing annotations (shapes + text) with percentage coordinates on each page.
GRADING_SYSTEM_PROMPT = r"""
You are an assistant that helps a teacher grade scanned student homework.

You will receive:
1. The standard answer page images (optional; may be absent).
2. The student's submitted homework page images.

Task: locate the questions in the student's work, compare each answer against
the standard answer (if provided), and annotate the pages by DRAWING on them,
exactly like a teacher marking with a red pen.

Output STRICT JSON only - a single JSON array, no commentary, no code fence:
[
  {"page_index": 0, "type": "shape", "shape": "tick",
   "x1": 0.30, "y1": 0.40, "x2": 0.34, "y2": 0.44},
  {"page_index": 0, "type": "shape", "shape": "cross",
   "x1": 0.30, "y1": 0.60, "x2": 0.34, "y2": 0.64},
  {"page_index": 0, "type": "shape", "shape": "rect" or "ellipse" or "line" or "arrow" or "circle",
   "x1": 0.20, "y1": 0.50, "x2": 0.60, "y2": 0.58},
  {"page_index": 1, "type": "text", "x": 0.25, "y": 0.32,
   "text": "short comment in the same language as the homework"}
]

Rules:
1. page_index is the 0-based index of the student page the item belongs to
   (0 = the first student page). It must be an integer between 0 and
   (number of student pages - 1). When only one student page is provided,
   page_index must be 0.
2. All coordinates are fractions of the page (0.0-1.0).
3. Use shape "tick" for a correct answer and "cross" for a wrong answer; place
   them right next to the answer. tick/cross are small (about 0.03-0.05 wide).
4. Use "rect" or "ellipse" to circle a question area, "line" or "arrow" to
   point at something, and "text" for a short written comment (under 40 chars).
5. Only annotate real questions/answers you can see. Do not invent marks.
6. If you cannot find any gradable answer, return [].
"""



def utc_now() -> str:
    """Return the current UTC time as an ISO-8601 string."""
    return datetime.now(timezone.utc).isoformat()


def load_accounts() -> dict[str, Any]:
    """Read the account store from secure/accounts.json."""
    if not ACCOUNTS_PATH.exists():
        return {}
    try:
        data = json.loads(ACCOUNTS_PATH.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def list_students() -> list[str]:
    """Return every username whose role is 'student', sorted."""
    accounts = load_accounts()
    return sorted(
        name
        for name, record in accounts.items()
        if isinstance(record, dict) and record.get("role") == "student"
    )


JOIN_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def generate_join_code(connection: sqlite3.Connection) -> str:
    """Return a short, unique, human-friendly classroom join code."""
    for _ in range(25):
        code = "".join(secrets.choice(JOIN_CODE_ALPHABET) for _ in range(6))
        exists = connection.execute(
            "SELECT 1 FROM classrooms WHERE join_code = ?", (code,)
        ).fetchone()
        if exists is None:
            return code
    raise RuntimeError("Unable to generate a unique join code.")


def lookup_role(username: str) -> str | None:
    """Return the account role for a username, or None when unknown."""
    record = load_accounts().get(username)
    if isinstance(record, dict):
        return str(record.get("role") or "")
    return None


def classroom_members(
    connection: sqlite3.Connection, classroom_id: int
) -> list[dict[str, str]]:
    rows = connection.execute(
        "SELECT username, role, joined_at FROM classroom_members "
        "WHERE classroom_id = ? ORDER BY role, username",
        (classroom_id,),
    ).fetchall()
    return [
        {
            "username": row["username"],
            "role": row["role"],
            "joined_at": row["joined_at"],
        }
        for row in rows
    ]


def classroom_json(row: sqlite3.Row, connection: sqlite3.Connection) -> dict[str, Any]:
    members = classroom_members(connection, row["id"])
    teacher_count = sum(1 for member in members if member["role"] == "teacher")
    homework_row = connection.execute(
        "SELECT COUNT(*) AS c FROM homework WHERE classroom_id = ?", (row["id"],)
    ).fetchone()
    return {
        "id": row["id"],
        "name": row["name"],
        "description": row["description"],
        "section": row["section"],
        "join_code": row["join_code"],
        "created_by": row["created_by"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "member_count": len(members),
        "teacher_count": teacher_count,
        "student_count": len(members) - teacher_count,
        "homework_count": homework_row["c"] if homework_row else 0,
        "members": members,
    }


def classrooms_for(
    connection: sqlite3.Connection, username: str
) -> list[sqlite3.Row]:
    """Every classroom the given user belongs to (as teacher or student)."""
    return connection.execute(
        "SELECT c.* FROM classrooms c "
        "JOIN classroom_members m ON m.classroom_id = c.id "
        "WHERE m.username = ? ORDER BY c.created_at DESC",
        (username,),
    ).fetchall()


def membership_role(
    connection: sqlite3.Connection, classroom_id: int, username: str
) -> str | None:
    row = connection.execute(
        "SELECT role FROM classroom_members WHERE classroom_id = ? AND username = ?",
        (classroom_id, username),
    ).fetchone()
    return row["role"] if row else None


def can_manage_classroom(
    connection: sqlite3.Connection, classroom_id: int, username: str
) -> bool:
    """The creator and any co-teacher member may manage a classroom."""
    row = connection.execute(
        "SELECT created_by FROM classrooms WHERE id = ?", (classroom_id,)
    ).fetchone()
    if row is None:
        return False
    if row["created_by"] == username:
        return True
    return membership_role(connection, classroom_id, username) == "teacher"


def verify_credentials(username: str, password: str) -> dict[str, str] | None:
    """Return the account when the username / sha256(password) pair matches."""
    record = load_accounts().get(username)
    if not isinstance(record, dict):
        return None
    stored = str(record.get("password_sha256", "")).strip().lower()
    digest = hashlib.sha256(password.encode("utf-8")).hexdigest()
    if not stored or not hmac.compare_digest(stored, digest):
        return None
    return {"username": username, "role": str(record.get("role") or "student")}


def login_required(view):
    """Require a signed-in session, otherwise redirect or return 401."""
    @wraps(view)
    def wrapped(*args: Any, **kwargs: Any):
        if "username" not in session:
            if request.path.startswith(("/api/", "/uploads/")):
                return jsonify(error="Authentication required."), 401
            return redirect(url_for("login", next=request.path))
        return view(*args, **kwargs)

    return wrapped


def role_required(*roles: str):
    """Restrict a view to the given roles."""

    def decorator(view):
        @wraps(view)
        @login_required
        def wrapped(*args: Any, **kwargs: Any):
            if session.get("role") not in roles:
                if request.path.startswith("/api/"):
                    return jsonify(error="You do not have access to this resource."), 403
                abort(403)
            return view(*args, **kwargs)

        return wrapped

    return decorator


def current_kind(role: str | None) -> str:
    """The page kind a role is allowed to edit."""
    return "answer" if role == "teacher" else "submission"


def get_db() -> sqlite3.Connection:
    connection = sqlite3.connect(DATABASE_PATH)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def initialize_database() -> None:
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    SECURE_DIR.mkdir(parents=True, exist_ok=True)
    with get_db() as connection:
        connection.execute(
            """CREATE TABLE IF NOT EXISTS homework (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                created_by TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )"""
        )
        connection.execute(
            """CREATE TABLE IF NOT EXISTS pages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                homework_id INTEGER NOT NULL,
                owner TEXT NOT NULL,
                kind TEXT NOT NULL,
                page_index INTEGER NOT NULL DEFAULT 0,
                image_filename TEXT NOT NULL,
                original_filename TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'submitted',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )"""
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_pages_lookup "
            "ON pages (homework_id, owner, kind, page_index)"
        )
        # Free-hand drawing strokes (Apple Pencil / touch / mouse) plus AI
        # drawing annotations, one JSON blob per (homework, student, page).
        connection.execute(
            """CREATE TABLE IF NOT EXISTS grade_drawings (
                homework_id INTEGER NOT NULL,
                student TEXT NOT NULL,
                page_index INTEGER NOT NULL,
                strokes TEXT NOT NULL DEFAULT '[]',
                updated_at TEXT NOT NULL,
                PRIMARY KEY (homework_id, student, page_index)
            )"""
        )
        # Migration: the old tick/cross mark system was removed.
        legacy = connection.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'grade_marks'"
        ).fetchone()
        if legacy:
            connection.execute("DROP TABLE grade_marks")
        # Per-student grading workflow status ('' = editing, 'returned' = sent
        # back to the student).
        connection.execute(
            """CREATE TABLE IF NOT EXISTS grading_status (
                homework_id INTEGER NOT NULL,
                student TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL,
                PRIMARY KEY (homework_id, student)
            )"""
        )
        # Migration: older databases predate the submission status column.
        page_columns = {
            item["name"]
            for item in connection.execute("PRAGMA table_info(pages)").fetchall()
        }
        if "status" not in page_columns:
            connection.execute(
                "ALTER TABLE pages ADD COLUMN status TEXT NOT NULL DEFAULT 'submitted'"
            )
        # Migration: markdown storage was removed; drop the legacy column.
        if "markdown" in page_columns:
            try:
                connection.execute("ALTER TABLE pages DROP COLUMN markdown")
            except sqlite3.OperationalError:
                pass
        # Classrooms own homework; members (teachers + students) join them.
        connection.execute(
            """CREATE TABLE IF NOT EXISTS classrooms (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                section TEXT NOT NULL DEFAULT '',
                join_code TEXT NOT NULL UNIQUE,
                created_by TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )"""
        )
        connection.execute(
            """CREATE TABLE IF NOT EXISTS classroom_members (
                classroom_id INTEGER NOT NULL,
                username TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'student',
                joined_at TEXT NOT NULL,
                PRIMARY KEY (classroom_id, username),
                FOREIGN KEY (classroom_id) REFERENCES classrooms (id) ON DELETE CASCADE
            )"""
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_members_username "
            "ON classroom_members (username)"
        )
        # AI practice sets: questions generated from returned homework or from
        # the student profile (personalized practice).
        connection.execute(
            """CREATE TABLE IF NOT EXISTS practice_sets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                homework_id INTEGER,
                student TEXT NOT NULL,
                source TEXT NOT NULL DEFAULT 'homework',
                questions TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL
            )"""
        )
        # AI learning reports (one per generated practice set).
        connection.execute(
            """CREATE TABLE IF NOT EXISTS practice_reports (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                homework_id INTEGER,
                student TEXT NOT NULL,
                report TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL
            )"""
        )
        # Per-student learning profile: strong / weak knowledge points plus a
        # short history, used to personalize every AI generation.
        connection.execute(
            """CREATE TABLE IF NOT EXISTS student_profiles (
                username TEXT PRIMARY KEY,
                profile TEXT NOT NULL DEFAULT '{}',
                updated_at TEXT NOT NULL
            )"""
        )
        # Migration: homework gains a classroom owner column.
        homework_columns = {
            item["name"]
            for item in connection.execute("PRAGMA table_info(homework)").fetchall()
        }
        if "classroom_id" not in homework_columns:
            connection.execute("ALTER TABLE homework ADD COLUMN classroom_id INTEGER")
        migrate_orphan_homework(connection)


def migrate_orphan_homework(connection: sqlite3.Connection) -> None:
    """Fold legacy, classroom-less homework into a default classroom.

    Older databases predate classrooms, so any homework without a classroom is
    moved into an auto-created "默认教室" per teacher (once). Safe to re-run.
    """
    rows = connection.execute(
        "SELECT DISTINCT created_by FROM homework WHERE classroom_id IS NULL"
    ).fetchall()
    if not rows:
        return
    now = utc_now()
    for row in rows:
        teacher = row["created_by"]
        existing = connection.execute(
            "SELECT id FROM classrooms WHERE created_by = ? AND name = ?",
            (teacher, "默认教室"),
        ).fetchone()
        if existing is None:
            join_code = generate_join_code(connection)
            cursor = connection.execute(
                "INSERT INTO classrooms "
                "(name, description, section, join_code, created_by, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                ("默认教室", "系统自动创建的教室（用于收纳迁移的旧作业）。",
                 "", join_code, teacher, now, now),
            )
            classroom_id = cursor.lastrowid
            connection.execute(
                "INSERT OR IGNORE INTO classroom_members "
                "(classroom_id, username, role, joined_at) VALUES (?, ?, 'teacher', ?)",
                (classroom_id, teacher, now),
            )
        else:
            classroom_id = existing["id"]
        for student in list_students():
            connection.execute(
                "INSERT OR IGNORE INTO classroom_members "
                "(classroom_id, username, role, joined_at) VALUES (?, ?, 'student', ?)",
                (classroom_id, student, now),
            )
        connection.execute(
            "UPDATE homework SET classroom_id = ? "
            "WHERE classroom_id IS NULL AND created_by = ?",
            (classroom_id, teacher),
        )


def page_json(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "homework_id": row["homework_id"],
        "owner": row["owner"],
        "kind": row["kind"],
        "page_index": row["page_index"],
        "image_filename": row["image_filename"],
        "original_filename": row["original_filename"],
        "status": row["status"],
        "image_url": f"/uploads/{row['image_filename']}",
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def homework_json(
    row: sqlite3.Row,
    connection: sqlite3.Connection,
    owner: str | None = None,
) -> dict[str, Any]:
    # When ``owner`` is given (a student asking about their own work), counts are
    # scoped so students never learn about the standard answer or classmates' work.
    if owner is None:
        counts = connection.execute(
            "SELECT kind, status, COUNT(*) AS c FROM pages "
            "WHERE homework_id = ? GROUP BY kind, status",
            (row["id"],),
        ).fetchall()
        submitters = connection.execute(
            "SELECT COUNT(DISTINCT owner) AS c FROM pages "
            "WHERE homework_id = ? AND kind = 'submission' AND status = 'submitted'",
            (row["id"],),
        ).fetchone()
        answer_pages = sum(item["c"] for item in counts if item["kind"] == "answer")
        submission_pages = sum(item["c"] for item in counts if item["kind"] == "submission")
        submitters_count = submitters["c"] if submitters else 0
    else:
        counts = connection.execute(
            "SELECT kind, status, COUNT(*) AS c FROM pages "
            "WHERE homework_id = ? AND owner = ? GROUP BY kind, status",
            (row["id"], owner),
        ).fetchall()
        answer_pages = 0
        submission_pages = sum(item["c"] for item in counts if item["kind"] == "submission")
        submitters_count = 0
    submitted_pages = sum(
        item["c"] for item in counts
        if item["kind"] == "submission" and item["status"] == "submitted"
    )
    draft_pages = submission_pages - submitted_pages
    if owner is not None:
        submitters_count = 1 if submitted_pages else 0
    classroom_name = None
    if row["classroom_id"] is not None:
        classroom_row = connection.execute(
            "SELECT name FROM classrooms WHERE id = ?", (row["classroom_id"],)
        ).fetchone()
        if classroom_row is not None:
            classroom_name = classroom_row["name"]
    return {
        "id": row["id"],
        "title": row["title"],
        "description": row["description"],
        "created_by": row["created_by"],
        "classroom_id": row["classroom_id"],
        "classroom_name": classroom_name,
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "answer_pages": answer_pages,
        "submission_pages": submission_pages,
        "submitted_pages": submitted_pages,
        "draft_pages": draft_pages,
        "submitters": submitters_count,
    }


def store_upload(image: Any) -> tuple[str, str]:
    """Persist an uploaded image and return (stored_name, original_name)."""
    original_name = secure_filename(image.filename or "")
    extension = original_name.rsplit(".", 1)[1].lower() if "." in original_name else ""
    if extension not in ALLOWED_EXTENSIONS:
        raise ValueError("Unsupported image type.")
    stored_name = f"{uuid.uuid4().hex}.{extension}"
    image.save(UPLOAD_DIR / stored_name)
    return stored_name, original_name


def _page_image_content(image_path: Path) -> dict[str, Any]:
    """Build an OpenAI vision content item for a stored page image.

    EXIF orientation is baked into the pixels first so the model sees the
    image exactly as the browser displays it (phone photos are often stored
    rotated with an EXIF flag).
    """
    path = Path(image_path)
    mime_type, _ = mimetypes.guess_type(str(path))
    mime_type = mime_type or "image/png"
    try:
        from PIL import Image, ImageOps

        with Image.open(path) as img:
            img = ImageOps.exif_transpose(img)
            if img.mode not in ("RGB", "L"):
                img = img.convert("RGB")
            import io

            buffer = io.BytesIO()
            img.save(buffer, format="JPEG", quality=90)
            encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
            mime_type = "image/jpeg"
        return {
            "type": "image_url",
            "image_url": {"url": f"data:{mime_type};base64,{encoded}", "detail": "high"},
        }
    except Exception:
        # Pillow unavailable or the file cannot be processed: fall back to the
        # raw bytes.
        encoded = base64.b64encode(path.read_bytes()).decode("ascii")
        return {
            "type": "image_url",
            "image_url": {"url": f"data:{mime_type};base64,{encoded}", "detail": "high"},
        }


def ai_assist_grade(
    answer_paths: list[Path], submission_paths: list[Path]
) -> dict[int, list[dict[str, Any]]]:
    """Ask the vision model to draw grading annotations on a student's pages.

    Returns {page_index: [items]} where each item is a drawing (shape or text)
    in the same format the frontend stores in grade_drawings.strokes. Raises
    RuntimeError on any model/parse error.
    """
    if not submission_paths:
        raise RuntimeError("No submission pages to grade.")
    content: list[dict[str, Any]] = []
    if answer_paths:
        content.append({"type": "text", "text": "Standard answer pages:"})
        for path in answer_paths:
            content.append(_page_image_content(path))
    content.append({"type": "text", "text": "Student submission pages:"})
    for index, path in enumerate(submission_paths):
        content.append({"type": "text", "text": f"Student page {index}:"})
        content.append(_page_image_content(path))
    client = OpenAI(api_key=API_KEY, base_url=API_BASE)
    response = client.chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content": GRADING_SYSTEM_PROMPT},
            {"role": "user", "content": content},
        ],
        max_tokens=8192,
        temperature=0.0,
    )
    raw = response.choices[0].message.content
    if not raw:
        raise RuntimeError("The model returned no content.")
    text = raw.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:]
    begin = text.find("[")
    finish = text.rfind("]")
    if begin == -1 or finish == -1 or finish <= begin:
        raise RuntimeError("The model did not return a JSON array.")
    try:
        items = json.loads(text[begin : finish + 1])
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Invalid JSON from the model: {exc}") from exc
    if not isinstance(items, list):
        raise RuntimeError("The model did not return a JSON array.")

    def clamp(value: Any, default: float = 0.5) -> float:
        try:
            number = float(value)
        except (TypeError, ValueError):
            return default
        if number > 1.0:
            # The model returned a 0-100 percentage instead of a fraction.
            number = number / 100.0
        return min(1.0, max(0.0, number))

    drawings: dict[int, list[dict[str, Any]]] = {}
    # With a single student page, normalise any page_index the model returns
    # (it may be 1-based or omitted) so valid marks are not dropped.
    single_page = len(submission_paths) == 1
    for item in items:
        if not isinstance(item, dict):
            continue
        try:
            page_index = int(item.get("page_index", 0))
        except (TypeError, ValueError):
            page_index = 0
        if single_page:
            page_index = 0
        if page_index < 0 or page_index >= len(submission_paths):
            continue
        kind = str(item.get("type") or "").strip().lower()
        if kind == "text":
            comment = str(item.get("text") or "").strip()[:200]
            if not comment:
                continue
            drawings.setdefault(page_index, []).append({
                "type": "text",
                "x": clamp(item.get("x")),
                "y": clamp(item.get("y")),
                "color": "#1565c0",
                "text": comment,
                "source": "ai",
            })
        elif kind == "shape":
            shape = str(item.get("shape") or "").strip().lower()
            if shape not in {"tick", "cross", "rect", "ellipse", "line", "arrow"}:
                shape = "rect"
            drawings.setdefault(page_index, []).append({
                "type": "shape",
                "shape": shape,
                "x1": clamp(item.get("x1"), 0.3),
                "y1": clamp(item.get("y1"), 0.3),
                "x2": clamp(item.get("x2"), 0.36),
                "y2": clamp(item.get("y2"), 0.36),
                "color": "#e02020",
                "width": 3,
                "source": "ai",
            })
    return drawings


# ---------------------------------------------------------------------------
# Personalized AI practice / report / student profile
# ---------------------------------------------------------------------------

PRACTICE_SYSTEM_PROMPT = r"""
You are a personalized AI tutor. You look at a student's returned homework
pages (including the teacher's grading annotations) and generate practice
questions plus a learning report, personalized to this specific student.

You will receive:
1. A summary of the student's learning profile (historical strong/weak points).
2. The student's homework page images, with a description of the teacher's
   grading marks (ticks = correct, crosses = wrong, text comments).

Output STRICT JSON only - a single JSON object, no commentary, no code fence:
{
  "questions": [
    {"topic": "知识点名称（与作业语言一致）",
     "target": "weak" or "current" or "strong",
     "difficulty": "basic" or "medium" or "advanced",
     "type": "choice",
     "question": "题干",
     "options": ["A. ...", "B. ...", "C. ...", "D. ..."],
     "answer": "A",
     "explanation": "简短解析"}
  ],
  "report": {
    "summary": "本次作业表现总结（2-3句，与作业语言一致）",
    "strengths": ["掌握较好的知识点"],
    "weaknesses": [{"topic": "薄弱知识点", "detail": "具体错误说明"}],
    "trend": "与历史表现对比的趋势描述（如首次学习则说明）",
    "advice": ["针对该学生的具体学习建议"]
  }
}

Rules:
1. Generate 6-8 questions. Personalize the mix using the profile:
   - about 60% target "weak" (recurring historical weak points),
   - about 30% target "current" (errors found in this homework),
   - about 10% target "strong" (consolidation).
   If the profile has no history yet, focus on this homework's errors.
2. Adapt difficulty to the profile: if historical accuracy is low, start with
   "basic" questions; otherwise include "medium"/"advanced".
3. Every question must be answerable from its text alone (self-contained).
4. "answer" must be exactly the option prefix letter (e.g. "A").
5. All text (questions, report) must be in the same language as the homework.
"""

PERSONAL_PRACTICE_SYSTEM_PROMPT = r"""
You are a personalized AI tutor. Generate a targeted practice set for ONE
student based purely on their learning profile (no homework images).

You will receive the student's profile: historical strong points, weak points
(with occurrence counts and last-seen dates), and recent practice history.

Output STRICT JSON only - a single JSON object, no commentary, no code fence:
{
  "questions": [
    {"topic": "知识点名称", "target": "weak" or "strong",
     "difficulty": "basic" or "medium" or "advanced",
     "type": "choice", "question": "题干",
     "options": ["A. ...", "B. ...", "C. ...", "D. ..."],
     "answer": "A", "explanation": "简短解析"}
  ],
  "report": {
    "summary": "本次个性化练习的设计思路（2-3句）",
    "strengths": [], "weaknesses": [], "trend": "", "advice": []
  }
}

Rules:
1. Generate 8 questions: mostly on the recurring weak points (weighted by
   occurrence count), plus 1-2 strong-point consolidation questions.
2. Difficulty adapts to recent accuracy (low accuracy -> start basic).
3. "answer" must be exactly the option prefix letter (e.g. "A").
4. All text must be in the same language as the profile/history.
"""


def load_profile(connection: sqlite3.Connection, username: str) -> dict[str, Any]:
    """Return the student's learning profile (empty dict when absent)."""
    row = connection.execute(
        "SELECT profile FROM student_profiles WHERE username = ?", (username,)
    ).fetchone()
    if row is None:
        return {}
    try:
        data = json.loads(row["profile"] or "{}")
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


def profile_summary(profile: dict[str, Any]) -> str:
    """Render a compact profile summary to inject into AI prompts."""
    if not profile:
        return "（暂无历史档案，这是该学生第一次使用，请完全依据本次作业内容。）"
    weak = profile.get("weak_points") or []
    strong = profile.get("strong_points") or []
    lines = ["学生学习档案："]
    if weak:
        items = []
        for item in weak:
            if isinstance(item, dict):
                items.append(
                    f"{item.get('topic', '?')}（出现{item.get('count', 1)}次，"
                    f"最近 {str(item.get('last_seen', ''))[:10]}）"
                )
            else:
                items.append(str(item))
        lines.append("- 历史弱项: " + "；".join(items))
    else:
        lines.append("- 历史弱项: 暂无记录")
    if strong:
        lines.append("- 历史强项: " + "；".join(str(s) for s in strong))
    history = profile.get("history") or []
    if history:
        for entry in history[-5:]:
            if isinstance(entry, dict):
                lines.append(
                    f"- 最近练习 {str(entry.get('date', ''))[:10]} "
                    f"{entry.get('title', '')} 正确率 {entry.get('accuracy', '?')}，"
                    f"薄弱: {', '.join(entry.get('weak', []) or []) or '无'}"
                )
    return "\n".join(lines)


def save_profile(connection: sqlite3.Connection, username: str, profile: dict[str, Any]) -> None:
    connection.execute(
        "INSERT INTO student_profiles (username, profile, updated_at) VALUES (?, ?, ?) "
        "ON CONFLICT (username) DO UPDATE SET profile = excluded.profile, "
        "updated_at = excluded.updated_at",
        (username, json.dumps(profile, ensure_ascii=False), utc_now()),
    )


def merge_report_into_profile(profile: dict[str, Any], report: dict[str, Any]) -> None:
    """Fold an AI report's strengths/weaknesses into the profile."""
    weak: dict[str, dict[str, Any]] = {}
    for item in profile.get("weak_points") or []:
        if isinstance(item, dict) and item.get("topic"):
            weak[item["topic"]] = dict(item)
        elif isinstance(item, str):
            weak[item] = {"topic": item, "count": 1, "last_seen": utc_now()}
    for item in report.get("weaknesses") or []:
        topic = str(item.get("topic") or "").strip() if isinstance(item, dict) else str(item)
        if not topic:
            continue
        entry = weak.setdefault(topic, {"topic": topic, "count": 0, "last_seen": ""})
        entry["count"] = int(entry.get("count") or 0) + 1
        entry["last_seen"] = utc_now()
        if isinstance(item, dict) and item.get("detail"):
            entry["detail"] = str(item["detail"])[:200]
    profile["weak_points"] = sorted(
        weak.values(), key=lambda e: -(int(e.get("count") or 0))
    )[:20]

    strong: list[str] = [str(s) for s in profile.get("strong_points") or []]
    for item in report.get("strengths") or []:
        topic = str(item).strip()
        if topic and topic not in strong:
            strong.append(topic)
    profile["strong_points"] = strong[:20]
    profile["weak_points"] = [
        w for w in profile["weak_points"] if w["topic"] not in strong
    ]


def update_profile_from_answers(
    profile: dict[str, Any],
    questions: list[dict[str, Any]],
    answers: dict[str, str],
) -> dict[str, Any]:
    """Grade answers, update weak points and append a history entry."""
    total = 0
    correct = 0
    wrong_topics: list[str] = []
    for index, question in enumerate(questions):
        expected = str(question.get("answer") or "").strip()
        given = str(answers.get(str(index)) or "").strip()
        if not expected:
            continue
        total += 1
        if given and given.upper() == expected.upper():
            correct += 1
        else:
            topic = str(question.get("topic") or "").strip()
            if topic and topic not in wrong_topics:
                wrong_topics.append(topic)
    accuracy = round(correct / total, 2) if total else 0.0

    weak: dict[str, dict[str, Any]] = {}
    for item in profile.get("weak_points") or []:
        if isinstance(item, dict) and item.get("topic"):
            weak[item["topic"]] = dict(item)
    for topic in wrong_topics:
        entry = weak.setdefault(topic, {"topic": topic, "count": 0, "last_seen": ""})
        entry["count"] = int(entry.get("count") or 0) + 1
        entry["last_seen"] = utc_now()
    profile["weak_points"] = sorted(
        weak.values(), key=lambda e: -(int(e.get("count") or 0))
    )[:20]

    history = profile.get("history") or []
    history.append({
        "date": utc_now(),
        "title": "AI 练习",
        "accuracy": accuracy,
        "weak": wrong_topics,
    })
    profile["history"] = history[-20:]
    return {"total": total, "correct": correct, "accuracy": accuracy}


def _extract_json_object(raw: str) -> dict[str, Any]:
    """Parse the first JSON object found in a model response."""
    text = (raw or "").strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:]
    begin = text.find("{")
    finish = text.rfind("}")
    if begin == -1 or finish == -1 or finish <= begin:
        raise RuntimeError("The model did not return a JSON object.")
    try:
        data = json.loads(text[begin : finish + 1])
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Invalid JSON from the model: {exc}") from exc
    if not isinstance(data, dict):
        raise RuntimeError("The model did not return a JSON object.")
    return data


def _clean_questions(raw_questions: Any) -> list[dict[str, Any]]:
    """Normalize the model's question list into a safe, uniform shape."""
    questions: list[dict[str, Any]] = []
    if not isinstance(raw_questions, list):
        return questions
    for item in raw_questions:
        if not isinstance(item, dict):
            continue
        question = str(item.get("question") or "").strip()
        options_raw = item.get("options")
        options = (
            [str(option).strip() for option in options_raw if str(option).strip()]
            if isinstance(options_raw, list) else []
        )
        answer = str(item.get("answer") or "").strip()
        if not question or len(options) < 2 or not answer:
            continue
        # Accept answers given as full option text; normalize to the letter.
        letter = answer[:1].upper()
        valid = {chr(65 + i) for i in range(len(options))}
        if letter not in valid:
            for i, option in enumerate(options):
                if option.startswith(answer):
                    letter = chr(65 + i)
                    break
            else:
                continue
        questions.append({
            "topic": str(item.get("topic") or "综合").strip()[:60],
            "target": str(item.get("target") or "current").strip()[:20],
            "difficulty": str(item.get("difficulty") or "medium").strip()[:20],
            "type": "choice",
            "question": question[:500],
            "options": options[:6],
            "answer": letter,
            "explanation": str(item.get("explanation") or "").strip()[:500],
        })
    return questions[:10]


def _clean_report(raw_report: Any) -> dict[str, Any]:
    """Normalize the model's report object."""
    if not isinstance(raw_report, dict):
        return {}
    weaknesses = []
    for item in raw_report.get("weaknesses") or []:
        if isinstance(item, dict) and item.get("topic"):
            weaknesses.append({
                "topic": str(item["topic"]).strip()[:60],
                "detail": str(item.get("detail") or "").strip()[:300],
            })
        elif isinstance(item, str) and item.strip():
            weaknesses.append({"topic": item.strip()[:60], "detail": ""})
    return {
        "summary": str(raw_report.get("summary") or "").strip()[:1000],
        "strengths": [
            str(s).strip()[:60] for s in (raw_report.get("strengths") or [])
            if str(s).strip()
        ][:10],
        "weaknesses": weaknesses[:10],
        "trend": str(raw_report.get("trend") or "").strip()[:500],
        "advice": [
            str(a).strip()[:300] for a in (raw_report.get("advice") or [])
            if str(a).strip()
        ][:10],
    }


def _call_llm_json(system_prompt: str, content: list[dict[str, Any]]) -> dict[str, Any]:
    client = OpenAI(api_key=API_KEY, base_url=API_BASE)
    response = client.chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": content},
        ],
        max_tokens=8192,
        temperature=0.3,
    )
    return _extract_json_object(response.choices[0].message.content or "")


def describe_grading_marks(drawings: dict[int, list[dict[str, Any]]]) -> str:
    """Turn the teacher's annotation strokes into a text description."""
    if not drawings:
        return "老师批改笔迹：无（未发现批注）。"
    lines = ["老师批改笔迹摘要："]
    for page_index in sorted(drawings):
        items = drawings[page_index]
        ticks = sum(1 for i in items if i.get("shape") == "tick")
        crosses = sum(1 for i in items if i.get("shape") == "cross")
        comments = [
            i.get("text", "") for i in items
            if i.get("type") == "text" and i.get("text")
        ]
        parts = []
        if ticks:
            parts.append(f"{ticks} 处正确")
        if crosses:
            parts.append(f"{crosses} 处错误")
        if comments:
            parts.append("批语: " + "；".join(str(c) for c in comments))
        if parts:
            lines.append(f"- 第 {page_index + 1} 页: " + "，".join(parts))
    return "\n".join(lines)


def ai_generate_homework_practice(
    profile: dict[str, Any],
    submission_paths: list[Path],
    drawings: dict[int, list[dict[str, Any]]],
    homework_title: str,
    with_questions: bool = True,
) -> dict[str, Any]:
    """Generate personalized practice + report from a returned homework."""
    if not submission_paths:
        raise RuntimeError("没有可分析的作业页面。")
    content: list[dict[str, Any]] = [
        {"type": "text", "text": profile_summary(profile)},
        {"type": "text", "text": f"作业标题：{homework_title}"},
        {"type": "text", "text": describe_grading_marks(drawings)},
        {"type": "text", "text": "学生作业页面："},
    ]
    for index, path in enumerate(submission_paths):
        content.append({"type": "text", "text": f"学生页面 {index}:"})
        content.append(_page_image_content(path))
    if not with_questions:
        content.append({
            "type": "text",
            "text": "注意：本次只需要生成学习报告（report），"
                    "不要生成练习题，questions 必须是空数组 []。",
        })
    data = _call_llm_json(PRACTICE_SYSTEM_PROMPT, content)
    questions = _clean_questions(data.get("questions")) if with_questions else []
    if with_questions and not questions:
        raise RuntimeError("AI 未能生成有效的练习题，请稍后重试。")
    report = _clean_report(data.get("report"))
    if not report.get("summary"):
        raise RuntimeError("AI 未能生成有效的学习报告，请稍后重试。")
    return {"questions": questions, "report": report}


def ai_generate_personal_practice(profile: dict[str, Any]) -> dict[str, Any]:
    """Generate a personalized practice set purely from the profile."""
    if not profile or not (profile.get("weak_points") or profile.get("history")):
        raise RuntimeError("档案中还没有学习记录，请先完成一次作业练习后再生成个性化练习。")
    data = _call_llm_json(
        PERSONAL_PRACTICE_SYSTEM_PROMPT,
        [{"type": "text", "text": profile_summary(profile)}],
    )
    questions = _clean_questions(data.get("questions"))
    if not questions:
        raise RuntimeError("AI 未能生成有效的练习题，请稍后重试。")
    return {"questions": questions, "report": _clean_report(data.get("report"))}


def create_app() -> Flask:
    app = Flask(
        __name__,
        static_folder=str(TEMPLATES_DIR),
        static_url_path="/assets",
        template_folder=str(TEMPLATES_DIR),
    )
    app.config["MAX_CONTENT_LENGTH"] = 20 * 1024 * 1024
    app.secret_key = SECRET_KEY
    initialize_database()

    @app.errorhandler(413)
    def too_large(_error: Any):
        return jsonify(error="The uploaded image exceeds the 20 MB limit."), 413

    @app.errorhandler(403)
    def forbidden(_error: Any):
        if request.path.startswith("/api/"):
            return jsonify(error="Forbidden."), 403
        return "403 Forbidden", 403

    @app.get("/")
    def index():
        if "username" not in session:
            return redirect(url_for("login"))
        if session.get("role") == "teacher":
            return redirect(url_for("teacher_page"))
        return redirect(url_for("student_page"))

    @app.route("/login", methods=["GET", "POST"])
    def login():
        error = None
        if request.method == "POST":
            username = (request.form.get("username") or "").strip()
            password = request.form.get("password") or ""
            account = verify_credentials(username, password)
            if account is None:
                error = "用户名或密码不正确。"
            else:
                session.clear()
                session["username"] = account["username"]
                session["role"] = account["role"]
                target = request.args.get("next") or ""
                if not target.startswith("/") or target.startswith("//"):
                    target = "/teacher" if account["role"] == "teacher" else "/student"
                return redirect(target)
        elif "username" in session:
            return redirect(url_for("index"))
        return render_template("login.html", error=error)

    @app.get("/logout")
    def logout():
        session.clear()
        return redirect(url_for("login"))

    @app.get("/teacher")
    @role_required("teacher")
    def teacher_page():
        return render_template("teacher.html")

    @app.get("/student")
    @role_required("student")
    def student_page():
        return render_template("student.html")

    @app.get("/homework/<int:homework_id>")
    @login_required
    def homework_page(homework_id: int):
        return render_template("homework.html", homework_id=homework_id)

    @app.get("/homework/<int:homework_id>/grade")
    @role_required("teacher")
    def grade_page(homework_id: int):
        return render_template("grade.html", homework_id=homework_id)

    @app.get("/classroom/<int:classroom_id>")
    @login_required
    def classroom_page(classroom_id: int):
        return render_template("classroom.html", classroom_id=classroom_id)

    @app.get("/uploads/<path:filename>")
    @login_required
    def uploaded_file(filename: str):
        return send_from_directory(UPLOAD_DIR, filename)

    @app.get("/api/me")
    @login_required
    def api_me():
        return jsonify(username=session["username"], role=session["role"])

    @app.get("/api/students")
    @role_required("teacher")
    def api_students():
        return jsonify(students=list_students())

    @app.get("/api/classrooms")
    @login_required
    def api_list_classrooms():
        username = session["username"]
        with get_db() as connection:
            rows = classrooms_for(connection, username)
            result = []
            for row in rows:
                data = classroom_json(row, connection)
                data["my_role"] = (
                    membership_role(connection, row["id"], username) or "student"
                )
                data["is_owner"] = row["created_by"] == username
                data["can_manage"] = can_manage_classroom(
                    connection, row["id"], username
                )
                result.append(data)
        return jsonify(classrooms=result)

    @app.post("/api/classrooms")
    @role_required("teacher")
    def api_create_classroom():
        payload = request.get_json(silent=True) or {}
        name = str(payload.get("name") or "").strip()
        if not name:
            return jsonify(error="请填写教室名称。"), 400
        description = str(payload.get("description") or "").strip()
        section = str(payload.get("section") or "").strip()
        username = session["username"]
        now = utc_now()
        with get_db() as connection:
            join_code = generate_join_code(connection)
            cursor = connection.execute(
                "INSERT INTO classrooms "
                "(name, description, section, join_code, created_by, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (name, description, section, join_code, username, now, now),
            )
            classroom_id = cursor.lastrowid
            connection.execute(
                "INSERT INTO classroom_members "
                "(classroom_id, username, role, joined_at) VALUES (?, ?, 'teacher', ?)",
                (classroom_id, username, now),
            )
            row = connection.execute(
                "SELECT * FROM classrooms WHERE id = ?", (classroom_id,)
            ).fetchone()
            result = classroom_json(row, connection)
        result["my_role"] = "teacher"
        result["is_owner"] = True
        result["can_manage"] = True
        return jsonify(classroom=result), 201

    @app.get("/api/classrooms/<int:classroom_id>")
    @login_required
    def api_get_classroom(classroom_id: int):
        username = session["username"]
        role = session.get("role")
        with get_db() as connection:
            row = connection.execute(
                "SELECT * FROM classrooms WHERE id = ?", (classroom_id,)
            ).fetchone()
            if row is None:
                return jsonify(error="教室不存在。"), 404
            my_role = membership_role(connection, classroom_id, username)
            if my_role is None:
                return jsonify(error="你尚未加入该教室。"), 403
            classroom = classroom_json(row, connection)
            classroom["my_role"] = my_role
            classroom["is_owner"] = row["created_by"] == username
            classroom["can_manage"] = can_manage_classroom(
                connection, classroom_id, username
            )
            # Students only ever see their own counts inside the classroom.
            owner = None if my_role == "teacher" else username
            hw_rows = connection.execute(
                "SELECT * FROM homework WHERE classroom_id = ? ORDER BY created_at DESC",
                (classroom_id,),
            ).fetchall()
            homeworks = [homework_json(hw, connection, owner) for hw in hw_rows]
        return jsonify(
            classroom=classroom,
            homeworks=homeworks,
            me={"username": username, "role": role},
        )

    @app.put("/api/classrooms/<int:classroom_id>")
    @login_required
    def api_update_classroom(classroom_id: int):
        username = session["username"]
        payload = request.get_json(silent=True) or {}
        with get_db() as connection:
            row = connection.execute(
                "SELECT * FROM classrooms WHERE id = ?", (classroom_id,)
            ).fetchone()
            if row is None:
                return jsonify(error="教室不存在。"), 404
            if not can_manage_classroom(connection, classroom_id, username):
                return jsonify(error="你没有权限管理该教室。"), 403
            name = str(payload.get("name", row["name"]) or "").strip()
            if not name:
                return jsonify(error="请填写教室名称。"), 400
            description = str(payload.get("description", row["description"]) or "").strip()
            section = str(payload.get("section", row["section"]) or "").strip()
            now = utc_now()
            connection.execute(
                "UPDATE classrooms SET name = ?, description = ?, section = ?, "
                "updated_at = ? WHERE id = ?",
                (name, description, section, now, classroom_id),
            )
            row = connection.execute(
                "SELECT * FROM classrooms WHERE id = ?", (classroom_id,)
            ).fetchone()
            result = classroom_json(row, connection)
        result["can_manage"] = True
        return jsonify(classroom=result)

    @app.post("/api/classrooms/<int:classroom_id>/code")
    @login_required
    def api_regenerate_classroom_code(classroom_id: int):
        username = session["username"]
        with get_db() as connection:
            row = connection.execute(
                "SELECT * FROM classrooms WHERE id = ?", (classroom_id,)
            ).fetchone()
            if row is None:
                return jsonify(error="教室不存在。"), 404
            if row["created_by"] != username:
                return jsonify(error="只有创建者可以重置邀请码。"), 403
            join_code = generate_join_code(connection)
            connection.execute(
                "UPDATE classrooms SET join_code = ?, updated_at = ? WHERE id = ?",
                (join_code, utc_now(), classroom_id),
            )
        return jsonify(join_code=join_code)

    @app.delete("/api/classrooms/<int:classroom_id>")
    @login_required
    def api_delete_classroom(classroom_id: int):
        username = session["username"]
        with get_db() as connection:
            row = connection.execute(
                "SELECT * FROM classrooms WHERE id = ?", (classroom_id,)
            ).fetchone()
            if row is None:
                return jsonify(error="教室不存在。"), 404
            if row["created_by"] != username:
                return jsonify(error="只有创建者可以删除教室。"), 403
            hw_rows = connection.execute(
                "SELECT id FROM homework WHERE classroom_id = ?", (classroom_id,)
            ).fetchall()
            image_names = []
            for hw in hw_rows:
                images = connection.execute(
                    "SELECT image_filename FROM pages WHERE homework_id = ?",
                    (hw["id"],),
                ).fetchall()
                image_names.extend(image["image_filename"] for image in images)
                connection.execute(
                    "DELETE FROM pages WHERE homework_id = ?", (hw["id"],)
                )
            connection.execute(
                "DELETE FROM homework WHERE classroom_id = ?", (classroom_id,)
            )
            connection.execute(
                "DELETE FROM classroom_members WHERE classroom_id = ?", (classroom_id,)
            )
            connection.execute("DELETE FROM classrooms WHERE id = ?", (classroom_id,))
        for name in image_names:
            (UPLOAD_DIR / name).unlink(missing_ok=True)
        return jsonify(ok=True)

    @app.post("/api/classrooms/join")
    @login_required
    def api_join_classroom():
        payload = request.get_json(silent=True) or {}
        code = str(payload.get("join_code") or "").strip().upper()
        if not code:
            return jsonify(error="请输入邀请码。"), 400
        username = session["username"]
        role = session.get("role") or "student"
        with get_db() as connection:
            row = connection.execute(
                "SELECT * FROM classrooms WHERE join_code = ?", (code,)
            ).fetchone()
            if row is None:
                return jsonify(error="邀请码无效。"), 404
            existing = membership_role(connection, row["id"], username)
            if existing is None:
                member_role = "teacher" if role == "teacher" else "student"
                connection.execute(
                    "INSERT INTO classroom_members "
                    "(classroom_id, username, role, joined_at) VALUES (?, ?, ?, ?)",
                    (row["id"], username, member_role, utc_now()),
                )
            result = classroom_json(row, connection)
        return jsonify(classroom=result, already_member=existing is not None)

    @app.post("/api/classrooms/<int:classroom_id>/leave")
    @login_required
    def api_leave_classroom(classroom_id: int):
        username = session["username"]
        with get_db() as connection:
            row = connection.execute(
                "SELECT * FROM classrooms WHERE id = ?", (classroom_id,)
            ).fetchone()
            if row is None:
                return jsonify(error="教室不存在。"), 404
            if row["created_by"] == username:
                return jsonify(error="创建者不能退出教室，请改为删除教室。"), 400
            connection.execute(
                "DELETE FROM classroom_members WHERE classroom_id = ? AND username = ?",
                (classroom_id, username),
            )
        return jsonify(ok=True)

    @app.post("/api/classrooms/<int:classroom_id>/members")
    @login_required
    def api_add_classroom_member(classroom_id: int):
        payload = request.get_json(silent=True) or {}
        username = str(payload.get("username") or "").strip()
        if not username:
            return jsonify(error="请输入用户名。"), 400
        caller = session["username"]
        with get_db() as connection:
            row = connection.execute(
                "SELECT * FROM classrooms WHERE id = ?", (classroom_id,)
            ).fetchone()
            if row is None:
                return jsonify(error="教室不存在。"), 404
            if not can_manage_classroom(connection, classroom_id, caller):
                return jsonify(error="你没有权限管理该教室。"), 403
            account_role = lookup_role(username)
            if account_role is None:
                return jsonify(error="该用户不存在。"), 404
            member_role = "teacher" if account_role == "teacher" else "student"
            connection.execute(
                "INSERT OR REPLACE INTO classroom_members "
                "(classroom_id, username, role, joined_at) VALUES (?, ?, ?, ?)",
                (classroom_id, username, member_role, utc_now()),
            )
            row = connection.execute(
                "SELECT * FROM classrooms WHERE id = ?", (classroom_id,)
            ).fetchone()
            result = classroom_json(row, connection)
        return jsonify(classroom=result)

    @app.delete("/api/classrooms/<int:classroom_id>/members/<username>")
    @login_required
    def api_remove_classroom_member(classroom_id: int, username: str):
        caller = session["username"]
        with get_db() as connection:
            row = connection.execute(
                "SELECT * FROM classrooms WHERE id = ?", (classroom_id,)
            ).fetchone()
            if row is None:
                return jsonify(error="教室不存在。"), 404
            if not can_manage_classroom(connection, classroom_id, caller):
                return jsonify(error="你没有权限管理该教室。"), 403
            if username == row["created_by"]:
                return jsonify(error="不能移除教室创建者。"), 400
            connection.execute(
                "DELETE FROM classroom_members WHERE classroom_id = ? AND username = ?",
                (classroom_id, username),
            )
            row = connection.execute(
                "SELECT * FROM classrooms WHERE id = ?", (classroom_id,)
            ).fetchone()
            result = classroom_json(row, connection)
        return jsonify(classroom=result)

    @app.post("/api/classrooms/<int:classroom_id>/homework")
    @login_required
    def api_create_classroom_homework(classroom_id: int):
        payload = request.get_json(silent=True) or {}
        title = str(payload.get("title") or "").strip()
        if not title:
            return jsonify(error="请填写作业标题。"), 400
        description = str(payload.get("description") or "").strip()
        caller = session["username"]
        now = utc_now()
        with get_db() as connection:
            row = connection.execute(
                "SELECT * FROM classrooms WHERE id = ?", (classroom_id,)
            ).fetchone()
            if row is None:
                return jsonify(error="教室不存在。"), 404
            if not can_manage_classroom(connection, classroom_id, caller):
                return jsonify(error="你没有权限在该教室布置作业。"), 403
            cursor = connection.execute(
                "INSERT INTO homework "
                "(title, description, classroom_id, created_by, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (title, description, classroom_id, caller, now, now),
            )
            hw = connection.execute(
                "SELECT * FROM homework WHERE id = ?", (cursor.lastrowid,)
            ).fetchone()
            result = homework_json(hw, connection)
        return jsonify(homework=result), 201

    @app.get("/api/homework")
    @login_required
    def api_list_homework():
        # Only homework inside classrooms the caller belongs to is returned;
        # students additionally see their own counts only.
        username = session["username"]
        role = session.get("role")
        owner = None if role == "teacher" else username
        with get_db() as connection:
            if role == "teacher":
                rows = connection.execute(
                    "SELECT h.* FROM homework h "
                    "JOIN classroom_members m ON m.classroom_id = h.classroom_id "
                    "WHERE m.username = ? AND m.role = 'teacher' "
                    "ORDER BY h.created_at DESC",
                    (username,),
                ).fetchall()
            else:
                rows = connection.execute(
                    "SELECT h.* FROM homework h "
                    "JOIN classroom_members m ON m.classroom_id = h.classroom_id "
                    "WHERE m.username = ? ORDER BY h.created_at DESC",
                    (username,),
                ).fetchall()
            result = [homework_json(row, connection, owner) for row in rows]
        return jsonify(homeworks=result)

    @app.post("/api/homework")
    @role_required("teacher")
    def api_create_homework():
        payload = request.get_json(silent=True) or {}
        title = str(payload.get("title") or "").strip()
        if not title:
            return jsonify(error="请填写作业标题。"), 400
        description = str(payload.get("description") or "").strip()
        caller = session["username"]
        classroom_id = payload.get("classroom_id")
        now = utc_now()
        with get_db() as connection:
            if classroom_id is None:
                return jsonify(error="请选择所属教室。"), 400
            try:
                classroom_id = int(classroom_id)
            except (TypeError, ValueError):
                return jsonify(error="无效的教室。"), 400
            row = connection.execute(
                "SELECT * FROM classrooms WHERE id = ?", (classroom_id,)
            ).fetchone()
            if row is None:
                return jsonify(error="教室不存在。"), 404
            if not can_manage_classroom(connection, classroom_id, caller):
                return jsonify(error="你没有权限在该教室布置作业。"), 403
            cursor = connection.execute(
                "INSERT INTO homework "
                "(title, description, classroom_id, created_by, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (title, description, classroom_id, caller, now, now),
            )
            row = connection.execute(
                "SELECT * FROM homework WHERE id = ?", (cursor.lastrowid,)
            ).fetchone()
            result = homework_json(row, connection)
        return jsonify(homework=result), 201

    @app.get("/api/homework/<int:homework_id>")
    @login_required
    def api_get_homework(homework_id: int):
        role = session.get("role")
        owner = None if role == "teacher" else session["username"]
        with get_db() as connection:
            row = connection.execute(
                "SELECT * FROM homework WHERE id = ?", (homework_id,)
            ).fetchone()
            if row is None:
                return jsonify(error="Homework not found."), 404
            my_role = None
            if row["classroom_id"] is not None:
                my_role = membership_role(
                    connection, row["classroom_id"], session["username"]
                )
                if my_role is None:
                    return jsonify(error="你尚未加入该作业所在的教室。"), 403
                if role == "teacher" and my_role != "teacher":
                    return jsonify(error="你无权访问该教室的作业。"), 403
            homework = homework_json(row, connection, owner)
            pages = connection.execute(
                "SELECT * FROM pages WHERE homework_id = ? ORDER BY owner, kind, page_index",
                (homework_id,),
            ).fetchall()
            # Roster is limited to this classroom's student members.
            if role == "teacher":
                if row["classroom_id"] is not None:
                    roster_students = [
                        member["username"]
                        for member in classroom_members(connection, row["classroom_id"])
                        if member["role"] == "student"
                    ]
                else:
                    roster_students = list_students()
            else:
                roster_students = []
        if role != "teacher":
            # Students must never receive the standard answer or other students'
            # submissions — only their own submission pages.
            pages = [
                page for page in pages
                if page["kind"] == "submission" and page["owner"] == session["username"]
            ]
            with get_db() as connection:
                status_row = connection.execute(
                    "SELECT status FROM grading_status "
                    "WHERE homework_id = ? AND student = ?",
                    (homework_id, session["username"]),
                ).fetchone()
                drawing_rows = connection.execute(
                    "SELECT page_index, strokes FROM grade_drawings "
                    "WHERE homework_id = ? AND student = ?",
                    (homework_id, session["username"]),
                ).fetchall()
            grading_status = status_row["status"] if status_row else ""
            # The teacher's annotations are only visible once the graded work
            # has been returned to the student.
            grading_drawings = (
                {str(item["page_index"]): json.loads(item["strokes"] or "[]")
                 for item in drawing_rows}
                if grading_status == "returned" else {}
            )
        else:
            grading_status = None
            grading_drawings = {}
        return jsonify(
            homework=homework,
            pages=[page_json(page) for page in pages],
            me={"username": session["username"], "role": session["role"]},
            students=roster_students,
            grading_status=grading_status,
            grading_drawings=grading_drawings,
        )

    @app.put("/api/homework/<int:homework_id>")
    @role_required("teacher")
    def api_update_homework(homework_id: int):
        payload = request.get_json(silent=True) or {}
        with get_db() as connection:
            row = connection.execute(
                "SELECT * FROM homework WHERE id = ?", (homework_id,)
            ).fetchone()
            if row is None:
                return jsonify(error="Homework not found."), 404
            if row["classroom_id"] is not None and not can_manage_classroom(
                connection, row["classroom_id"], session["username"]
            ):
                return jsonify(error="你没有权限管理该教室的作业。"), 403
            title = str(payload.get("title", row["title"]) or "").strip()
            if not title:
                return jsonify(error="请填写作业标题。"), 400
            description = str(payload.get("description", row["description"]) or "").strip()
            now = utc_now()
            connection.execute(
                "UPDATE homework SET title = ?, description = ?, updated_at = ? WHERE id = ?",
                (title, description, now, homework_id),
            )
            row = connection.execute(
                "SELECT * FROM homework WHERE id = ?", (homework_id,)
            ).fetchone()
            result = homework_json(row, connection)
        return jsonify(homework=result)

    @app.delete("/api/homework/<int:homework_id>")
    @role_required("teacher")
    def api_delete_homework(homework_id: int):
        with get_db() as connection:
            row = connection.execute(
                "SELECT * FROM homework WHERE id = ?", (homework_id,)
            ).fetchone()
            if row is None:
                return jsonify(error="Homework not found."), 404
            if row["classroom_id"] is not None and not can_manage_classroom(
                connection, row["classroom_id"], session["username"]
            ):
                return jsonify(error="你没有权限管理该教室的作业。"), 403
            connection.execute("DELETE FROM pages WHERE homework_id = ?", (homework_id,))
            connection.execute("DELETE FROM homework WHERE id = ?", (homework_id,))
        return jsonify(ok=True)

    @app.post("/api/convert")
    @login_required
    def api_convert():
        image = request.files.get("image")
        if image is None or not image.filename:
            return jsonify(error="Choose an image to upload."), 400
        try:
            stored_name, original_name = store_upload(image)
        except ValueError as exc:
            return jsonify(error=str(exc)), 400
        return jsonify(page={
            "image_filename": stored_name,
            "original_filename": original_name,
        }), 201

    @app.put("/api/homework/<int:homework_id>/pages")
    @login_required
    def api_sync_pages(homework_id: int):
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            return jsonify(error="A JSON body is required."), 400
        kind = payload.get("kind")
        if kind not in PAGE_KINDS:
            return jsonify(error="Unknown page kind."), 400
        if kind != current_kind(session.get("role")):
            return jsonify(error="You cannot edit this page kind."), 403
        raw_pages = payload.get("pages")
        if not isinstance(raw_pages, list):
            return jsonify(error="pages must be a list."), 400
        # Students may save a draft first, then submit later; the standard answer
        # is always treated as final.
        status = payload.get("status")
        if status not in {"draft", "submitted"} or kind == "answer":
            status = "submitted"
        owner = session["username"]
        now = utc_now()
        with get_db() as connection:
            exists = connection.execute(
                "SELECT classroom_id FROM homework WHERE id = ?", (homework_id,)
            ).fetchone()
            if exists is None:
                return jsonify(error="Homework not found."), 404
            if exists["classroom_id"] is not None:
                my_role = membership_role(connection, exists["classroom_id"], owner)
                if my_role is None:
                    return jsonify(error="你尚未加入该作业所在的教室。"), 403
                if kind == "answer" and my_role != "teacher":
                    return jsonify(error="你无权编辑该教室的标准答案。"), 403
            existing_ids = {
                item["id"]
                for item in connection.execute(
                    "SELECT id FROM pages WHERE homework_id = ? AND owner = ? AND kind = ?",
                    (homework_id, owner, kind),
                ).fetchall()
            }
            keep_ids: set[int] = set()
            for index, item in enumerate(raw_pages):
                if not isinstance(item, dict):
                    continue
                page_id = item.get("id")
                if isinstance(page_id, int) and page_id in existing_ids:
                    keep_ids.add(page_id)
                    connection.execute(
                        "UPDATE pages SET page_index = ?, status = ?, "
                        "updated_at = ? WHERE id = ?",
                        (index, status, now, page_id),
                    )
                    continue
                image_filename = str(item.get("image_filename") or "").strip()
                if not image_filename:
                    continue
                original_filename = str(item.get("original_filename") or image_filename)
                cursor = connection.execute(
                    "INSERT INTO pages "
                    "(homework_id, owner, kind, page_index, image_filename, "
                    " original_filename, status, created_at, updated_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (homework_id, owner, kind, index, image_filename,
                     original_filename, status, now, now),
                )
                keep_ids.add(cursor.lastrowid)
            for stale in existing_ids - keep_ids:
                connection.execute("DELETE FROM pages WHERE id = ?", (stale,))
            connection.execute(
                "UPDATE homework SET updated_at = ? WHERE id = ?", (now, homework_id)
            )
            pages = connection.execute(
                "SELECT * FROM pages WHERE homework_id = ? AND owner = ? AND kind = ? "
                "ORDER BY page_index",
                (homework_id, owner, kind),
            ).fetchall()
        return jsonify(pages=[page_json(page) for page in pages])

    @app.put("/api/homework/<int:homework_id>/submission")
    @role_required("student")
    def api_set_submission_status(homework_id: int):
        # Flip every one of the caller's submission pages between draft and
        # submitted without resending the pages themselves.
        payload = request.get_json(silent=True) or {}
        status = payload.get("status")
        if status not in {"draft", "submitted"}:
            return jsonify(error="status must be 'draft' or 'submitted'."), 400
        owner = session["username"]
        now = utc_now()
        with get_db() as connection:
            exists = connection.execute(
                "SELECT classroom_id FROM homework WHERE id = ?", (homework_id,)
            ).fetchone()
            if exists is None:
                return jsonify(error="Homework not found."), 404
            if exists["classroom_id"] is not None and membership_role(
                connection, exists["classroom_id"], owner
            ) is None:
                return jsonify(error="你尚未加入该作业所在的教室。"), 403
            updated = connection.execute(
                "UPDATE pages SET status = ?, updated_at = ? "
                "WHERE homework_id = ? AND owner = ? AND kind = 'submission'",
                (status, now, homework_id, owner),
            ).rowcount
            if updated:
                connection.execute(
                    "UPDATE homework SET updated_at = ? WHERE id = ?", (now, homework_id)
                )
        return jsonify(ok=True, status=status, updated=updated)

    # ---------- Teacher grading (drawing annotations + AI assist) ----------

    def load_homework_for_teacher(connection: sqlite3.Connection, homework_id: int):
        """Return (homework_row, error_response) for a grading teacher."""
        row = connection.execute(
            "SELECT * FROM homework WHERE id = ?", (homework_id,)
        ).fetchone()
        if row is None:
            return None, (jsonify(error="Homework not found."), 404)
        if row["classroom_id"] is not None and membership_role(
            connection, row["classroom_id"], session["username"]
        ) != "teacher":
            return None, (jsonify(error="你无权批改该教室的作业。"), 403)
        return row, None

    @app.get("/api/homework/<int:homework_id>/grading")
    @role_required("teacher")
    def api_get_grading(homework_id: int):
        student = (request.args.get("student") or "").strip()
        if not student:
            return jsonify(error="请选择要批改的学生。"), 400
        with get_db() as connection:
            row, error = load_homework_for_teacher(connection, homework_id)
            if error is not None:
                return error
            answer_pages = connection.execute(
                "SELECT * FROM pages WHERE homework_id = ? AND kind = 'answer' "
                "ORDER BY page_index",
                (homework_id,),
            ).fetchall()
            submission_pages = connection.execute(
                "SELECT * FROM pages WHERE homework_id = ? AND kind = 'submission' "
                "AND owner = ? ORDER BY page_index",
                (homework_id, student),
            ).fetchall()
            drawings = connection.execute(
                "SELECT page_index, strokes FROM grade_drawings "
                "WHERE homework_id = ? AND student = ?",
                (homework_id, student),
            ).fetchall()
            status_row = connection.execute(
                "SELECT status FROM grading_status "
                "WHERE homework_id = ? AND student = ?",
                (homework_id, student),
            ).fetchone()
        return jsonify(
            homework={"id": row["id"], "title": row["title"]},
            student=student,
            answer_pages=[page_json(page) for page in answer_pages],
            submission_pages=[page_json(page) for page in submission_pages],
            drawings={str(item["page_index"]): json.loads(item["strokes"] or "[]")
                      for item in drawings},
            grading_status=(status_row["status"] if status_row else ""),
        )

    @app.post("/api/homework/<int:homework_id>/grading/discard")
    @role_required("teacher")
    def api_discard_grading(homework_id: int):
        """Discard all saved grading annotations for a student."""
        payload = request.get_json(silent=True) or {}
        student = str(payload.get("student") or "").strip()
        if not student:
            return jsonify(error="请选择要批改的学生。"), 400
        with get_db() as connection:
            _, error = load_homework_for_teacher(connection, homework_id)
            if error is not None:
                return error
            connection.execute(
                "DELETE FROM grade_drawings WHERE homework_id = ? AND student = ?",
                (homework_id, student),
            )
        return jsonify(ok=True)

    @app.post("/api/homework/<int:homework_id>/grading/return")
    @role_required("teacher")
    def api_return_grading(homework_id: int):
        """Return the graded homework to the student (or cancel the return)."""
        payload = request.get_json(silent=True) or {}
        student = str(payload.get("student") or "").strip()
        returned = bool(payload.get("returned"))
        if not student:
            return jsonify(error="请选择要批改的学生。"), 400
        now = utc_now()
        status = "returned" if returned else ""
        with get_db() as connection:
            _, error = load_homework_for_teacher(connection, homework_id)
            if error is not None:
                return error
            connection.execute(
                "INSERT INTO grading_status (homework_id, student, status, updated_at) "
                "VALUES (?, ?, ?, ?) "
                "ON CONFLICT (homework_id, student) "
                "DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at",
                (homework_id, student, status, now),
            )
        return jsonify(ok=True, grading_status=status)

    @app.post("/api/homework/<int:homework_id>/grading/ai")
    @role_required("teacher")
    def api_ai_grading(homework_id: int):
        payload = request.get_json(silent=True) or {}
        student = str(payload.get("student") or "").strip()
        if not student:
            return jsonify(error="请选择要批改的学生。"), 400
        with get_db() as connection:
            row, error = load_homework_for_teacher(connection, homework_id)
            if error is not None:
                return error
            answer_pages = connection.execute(
                "SELECT image_filename FROM pages WHERE homework_id = ? AND kind = 'answer' "
                "ORDER BY page_index",
                (homework_id,),
            ).fetchall()
            submission_pages = connection.execute(
                "SELECT image_filename FROM pages WHERE homework_id = ? "
                "AND kind = 'submission' AND owner = ? ORDER BY page_index",
                (homework_id, student),
            ).fetchall()
        if not submission_pages:
            return jsonify(error="该学生还没有提交作业页面。"), 400
        # Optional page range (1-based, inclusive) so the teacher can grade a
        # subset of pages; the frontend batches requests of at most 3 pages.
        total_pages = len(submission_pages)
        try:
            page_start = int(payload.get("page_start") or 1)
            page_end = int(payload.get("page_end") or total_pages)
        except (TypeError, ValueError):
            return jsonify(error="页码范围无效。"), 400
        page_start = max(1, min(total_pages, page_start))
        page_end = max(1, min(total_pages, page_end))
        if page_start > page_end:
            page_start, page_end = page_end, page_start
        offset = page_start - 1
        selected_pages = submission_pages[page_start - 1 : page_end]
        try:
            ai_drawings = ai_assist_grade(
                [UPLOAD_DIR / item["image_filename"] for item in answer_pages],
                [UPLOAD_DIR / item["image_filename"] for item in selected_pages],
            )
        except Exception as exc:
            return jsonify(error=f"AI 批改失败：{exc}"), 502
        # Remap batch-relative page indices to absolute page indices.
        ai_drawings = {offset + page_index: items
                       for page_index, items in ai_drawings.items()}
        now = utc_now()
        with get_db() as connection:
            _, error = load_homework_for_teacher(connection, homework_id)
            if error is not None:
                return error
            # Append the AI drawings to whatever the teacher already drew.
            for page_index, items in ai_drawings.items():
                existing = connection.execute(
                    "SELECT strokes FROM grade_drawings "
                    "WHERE homework_id = ? AND student = ? AND page_index = ?",
                    (homework_id, student, page_index),
                ).fetchone()
                strokes = json.loads(existing["strokes"] or "[]") if existing else []
                strokes.extend(items)
                connection.execute(
                    "INSERT INTO grade_drawings (homework_id, student, page_index, strokes, updated_at) "
                    "VALUES (?, ?, ?, ?, ?) "
                    "ON CONFLICT (homework_id, student, page_index) "
                    "DO UPDATE SET strokes = excluded.strokes, updated_at = excluded.updated_at",
                    (homework_id, student, page_index, json.dumps(strokes), now),
                )
        return jsonify(drawings={str(page): items
                                 for page, items in ai_drawings.items()},
                       total=sum(len(items) for items in ai_drawings.values()))

    @app.put("/api/homework/<int:homework_id>/grading/drawings")
    @role_required("teacher")
    def api_save_drawings(homework_id: int):
        payload = request.get_json(silent=True) or {}
        student = str(payload.get("student") or "").strip()
        page_index = payload.get("page_index")
        strokes = payload.get("strokes")
        if not student or not isinstance(page_index, int) or not isinstance(strokes, list):
            return jsonify(error="笔迹数据无效。"), 400
        now = utc_now()
        with get_db() as connection:
            _, error = load_homework_for_teacher(connection, homework_id)
            if error is not None:
                return error
            connection.execute(
                "INSERT INTO grade_drawings (homework_id, student, page_index, strokes, updated_at) "
                "VALUES (?, ?, ?, ?, ?) "
                "ON CONFLICT (homework_id, student, page_index) "
                "DO UPDATE SET strokes = excluded.strokes, updated_at = excluded.updated_at",
                (homework_id, student, page_index, json.dumps(strokes), now),
            )
        return jsonify(ok=True)

    # ---------- Student AI practice / report / profile ----------

    def practice_json(row: sqlite3.Row, report_row: sqlite3.Row | None) -> dict[str, Any]:
        return {
            "id": row["id"],
            "homework_id": row["homework_id"],
            "source": row["source"],
            "questions": json.loads(row["questions"] or "[]"),
            "created_at": row["created_at"],
            "report": json.loads(report_row["report"] or "{}") if report_row else {},
        }

    @app.post("/api/homework/<int:homework_id>/practice/generate")
    @role_required("student")
    def api_generate_homework_practice(homework_id: int):
        username = session["username"]
        payload = request.get_json(silent=True) or {}
        with get_db() as connection:
            homework = connection.execute(
                "SELECT * FROM homework WHERE id = ?", (homework_id,)
            ).fetchone()
            if homework is None:
                return jsonify(error="Homework not found."), 404
            if homework["classroom_id"] is not None and membership_role(
                connection, homework["classroom_id"], username
            ) is None:
                return jsonify(error="你尚未加入该作业所在的教室。"), 403
            status_row = connection.execute(
                "SELECT status FROM grading_status WHERE homework_id = ? AND student = ?",
                (homework_id, username),
            ).fetchone()
            if not status_row or status_row["status"] != "returned":
                return jsonify(error="老师尚未发还这份作业的批改结果。"), 400
            pages = connection.execute(
                "SELECT * FROM pages WHERE homework_id = ? AND owner = ? "
                "AND kind = 'submission' ORDER BY page_index",
                (homework_id, username),
            ).fetchall()
            drawing_rows = connection.execute(
                "SELECT page_index, strokes FROM grade_drawings "
                "WHERE homework_id = ? AND student = ?",
                (homework_id, username),
            ).fetchall()
            profile = load_profile(connection, username)
        drawings = {
            item["page_index"]: json.loads(item["strokes"] or "[]")
            for item in drawing_rows
        }
        try:
            result = ai_generate_homework_practice(
                profile,
                [UPLOAD_DIR / page["image_filename"] for page in pages],
                drawings,
                homework["title"],
                with_questions=bool(payload.get("with_questions", True)),
            )
        except Exception as exc:
            return jsonify(error=f"AI 生成练习失败：{exc}"), 502
        now = utc_now()
        with get_db() as connection:
            cursor = connection.execute(
                "INSERT INTO practice_sets (homework_id, student, source, questions, created_at) "
                "VALUES (?, ?, 'homework', ?, ?)",
                (homework_id, username, json.dumps(result["questions"], ensure_ascii=False), now),
            )
            practice_id = cursor.lastrowid
            connection.execute(
                "INSERT INTO practice_reports (homework_id, student, report, created_at) "
                "VALUES (?, ?, ?, ?)",
                (homework_id, username, json.dumps(result["report"], ensure_ascii=False), now),
            )
            merge_report_into_profile(profile, result["report"])
            save_profile(connection, username, profile)
        return jsonify(practice={
            "id": practice_id,
            "homework_id": homework_id,
            "source": "homework",
            "questions": result["questions"],
            "created_at": now,
            "report": result["report"],
        }), 201

    @app.get("/api/homework/<int:homework_id>/practice")
    @role_required("student")
    def api_get_homework_practice(homework_id: int):
        username = session["username"]
        with get_db() as connection:
            row = connection.execute(
                "SELECT * FROM practice_sets WHERE homework_id = ? AND student = ? "
                "ORDER BY created_at DESC LIMIT 1",
                (homework_id, username),
            ).fetchone()
            if row is None:
                return jsonify(practice=None)
            report_row = connection.execute(
                "SELECT * FROM practice_reports WHERE homework_id = ? AND student = ? "
                "ORDER BY created_at DESC LIMIT 1",
                (homework_id, username),
            ).fetchone()
        return jsonify(practice=practice_json(row, report_row))

    @app.post("/api/practice/<int:practice_id>/submit")
    @role_required("student")
    def api_submit_practice(practice_id: int):
        payload = request.get_json(silent=True) or {}
        raw_answers = payload.get("answers")
        if not isinstance(raw_answers, dict):
            return jsonify(error="answers must be an object."), 400
        answers = {str(k): str(v) for k, v in raw_answers.items()}
        username = session["username"]
        with get_db() as connection:
            row = connection.execute(
                "SELECT * FROM practice_sets WHERE id = ? AND student = ?",
                (practice_id, username),
            ).fetchone()
            if row is None:
                return jsonify(error="练习不存在。"), 404
            questions = json.loads(row["questions"] or "[]")
            profile = load_profile(connection, username)
            result = update_profile_from_answers(profile, questions, answers)
            save_profile(connection, username, profile)
        return jsonify(ok=True, result=result)

    @app.get("/profile")
    @login_required
    def profile_page():
        if session.get("role") != "student":
            return redirect(url_for("index"))
        return render_template("profile.html")

    @app.delete("/api/profile")
    @role_required("student")
    def api_reset_profile():
        username = session["username"]
        with get_db() as connection:
            connection.execute(
                "DELETE FROM student_profiles WHERE username = ?", (username,)
            )
        return jsonify(ok=True)

    @app.get("/api/profile")
    @role_required("student")
    def api_get_profile():
        username = session["username"]
        with get_db() as connection:
            profile = load_profile(connection, username)
            rows = connection.execute(
                "SELECT p.id, p.homework_id, p.source, p.created_at "
                "FROM practice_sets p WHERE p.student = ? "
                "ORDER BY p.created_at DESC LIMIT 20",
                (username,),
            ).fetchall()
        return jsonify(profile=profile, practices=[
            {
                "id": row["id"],
                "homework_id": row["homework_id"],
                "source": row["source"],
                "created_at": row["created_at"],
            }
            for row in rows
        ])

    @app.post("/api/profile/practice/generate")
    @role_required("student")
    def api_generate_personal_practice():
        username = session["username"]
        with get_db() as connection:
            profile = load_profile(connection, username)
        try:
            result = ai_generate_personal_practice(profile)
        except Exception as exc:
            return jsonify(error=f"AI 生成个性化练习失败：{exc}"), 502
        now = utc_now()
        with get_db() as connection:
            cursor = connection.execute(
                "INSERT INTO practice_sets (homework_id, student, source, questions, created_at) "
                "VALUES (NULL, ?, 'personal', ?, ?)",
                (username, json.dumps(result["questions"], ensure_ascii=False), now),
            )
            practice_id = cursor.lastrowid
            connection.execute(
                "INSERT INTO practice_reports (homework_id, student, report, created_at) "
                "VALUES (NULL, ?, ?, ?)",
                (username, json.dumps(result["report"], ensure_ascii=False), now),
            )
            merge_report_into_profile(profile, result["report"])
            save_profile(connection, username, profile)
        return jsonify(practice={
            "id": practice_id,
            "homework_id": None,
            "source": "personal",
            "questions": result["questions"],
            "created_at": now,
            "report": result["report"],
        }), 201

    return app


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the homework scan / grading Flask server")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=5000)
    args = parser.parse_args()
    create_app().run(host=args.host, port=args.port, debug=1)


if __name__ == "__main__":
    main()