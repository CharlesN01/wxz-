"""Private, owner-bound import files; no browser-controlled filesystem paths."""

import hashlib
import hmac
import json
import os
from pathlib import Path
import shutil
import tempfile
from datetime import timedelta
from uuid import UUID, uuid4

from django.conf import settings
from django.core import signing
from django.db import DatabaseError
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from .import_services import (
    WritingImportError, completed_import_result, require_import_permission, stable_digest,
)


PREVIEW_SECONDS = 30 * 60
# Leave room for an hourly cleanup timer while guaranteeing removal within 24h
# during normal operation. A persistent timer catches up after host downtime.
RETENTION_SECONDS = 22 * 60 * 60
SIGNING_SALT = "writing.import.confirm.v1"
STORAGE_SALT = "writing.import.storage.v1"


def _root():
    root = Path(getattr(settings, "WRITING_IMPORT_TMP_DIR", Path(settings.BASE_DIR) / ".local" / "writing-imports")).resolve()
    for name in ("MEDIA_ROOT", "STATIC_ROOT"):
        public = getattr(settings, name, None)
        if public:
            public = Path(public).resolve()
            if root == public or public in root.parents:
                raise WritingImportError("IMPORT_UNAVAILABLE", "导入临时目录配置不安全，请联系管理员使用私有目录。", 503)
    return root


def _preview_id(value):
    try:
        parsed = UUID(str(value))
        if str(parsed) != str(value) or parsed.version != 4:
            raise ValueError
        return str(parsed)
    except (TypeError, ValueError, AttributeError) as error:
        raise WritingImportError("PREVIEW_NOT_FOUND", "预览不存在，请重新上传文件。", 404) from error


def _plan_digest(preview):
    return stable_digest({key: preview[key] for key in (
        "owner", "mode", "counts", "dictionaries", "issues", "rows", "plan", "dependencies", "canConfirm",
    )})


def _signature_payload(preview):
    return {key: preview[key] for key in (
        "previewId", "owner", "mode", "fileDigest", "planDigest", "createdAt", "expiresAt",
    )}


def _atomic_write(path, raw):
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".writing-", delete=False) as output:
            temporary = output.name
            os.chmod(temporary, 0o600)
            output.write(raw)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)


def save_preview(actor, raw, preview):
    actor = require_import_permission(actor, preview)
    if preview.get("owner") != str(actor.pk):
        raise WritingImportError("PERMISSION_DENIED", "只能保存自己的导入预览。", 403)
    if not isinstance(raw, bytes) or len(raw) > 5 * 1024 * 1024:
        raise WritingImportError("INVALID_WORKBOOK", "请上传不超过 5 MiB 的 Excel 文件。")
    # Round-trip removes external object references and makes the stored plan immutable
    # from the caller's perspective, while preserving every original text character.
    saved = json.loads(json.dumps(preview, ensure_ascii=False))
    now = timezone.now()
    saved.update({
        "previewId": str(uuid4()), "fileDigest": hashlib.sha256(raw).hexdigest(),
        "createdAt": now.isoformat(), "expiresAt": (now + timedelta(seconds=PREVIEW_SECONDS)).isoformat(),
    })
    saved["planDigest"] = _plan_digest(saved)
    saved["confirmationToken"] = signing.dumps(_signature_payload(saved), salt=SIGNING_SALT, compress=True) if saved["canConfirm"] and not saved["issues"] else None
    saved["storageSignature"] = signing.dumps(_signature_payload(saved), salt=STORAGE_SALT, compress=True)
    folder = None
    try:
        root = _root()
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
        folder = root / saved["previewId"]
        folder.mkdir(mode=0o700)
        _atomic_write(folder / "raw.xlsx", raw)
        _atomic_write(folder / "plan.json", json.dumps(saved, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
    except WritingImportError:
        raise
    except (OSError, ValueError) as error:
        if folder and folder.exists():
            shutil.rmtree(folder, ignore_errors=True)
        raise WritingImportError("IMPORT_UNAVAILABLE", "预览暂时无法保存，请稍后重新上传。", 503) from error
    return saved


def load_preview(preview_id, actor, token=None):
    actor = require_import_permission(actor)
    preview_id = _preview_id(preview_id)
    try:
        root = _root()
        folder = root / preview_id
        if folder.is_symlink() or not folder.is_dir():
            raise WritingImportError("PREVIEW_NOT_FOUND", "预览不存在或已清理，请重新上传。", 404)
        paths = [folder / "plan.json", folder / "raw.xlsx"]
        if any(path.is_symlink() for path in paths):
            raise WritingImportError("PREVIEW_CONFLICT", "预览文件异常，请重新上传。", 409)
        with paths[0].open("r", encoding="utf-8") as source:
            preview = json.load(source)
        if preview["previewId"] != preview_id:
            raise ValueError
        # Verify the envelope before trusting owner or expiry, including error previews.
        payload = _signature_payload(preview)
        if signing.loads(preview["storageSignature"], salt=STORAGE_SALT) != payload:
            raise ValueError
        if preview["owner"] != str(actor.pk):
            raise WritingImportError("PERMISSION_DENIED", "只能查看自己的导入预览和报告。", 403)
        expires_at = parse_datetime(preview["expiresAt"])
        if expires_at is None or timezone.is_naive(expires_at):
            raise ValueError
        if timezone.now() >= expires_at:
            raise WritingImportError("PREVIEW_EXPIRED", "预览已超过 30 分钟，请重新上传核对。", 410)
        # Check the signed digest before any code traverses a possibly corrupt
        # nested plan (for example a JSON list in place of the plan object).
        if not hmac.compare_digest(_plan_digest(preview), preview["planDigest"]):
            raise ValueError
        require_import_permission(actor, preview)
        with paths[1].open("rb") as source:
            raw = source.read(5 * 1024 * 1024 + 1)
        if len(raw) > 5 * 1024 * 1024 or not hmac.compare_digest(hashlib.sha256(raw).hexdigest(), preview["fileDigest"]):
            raise ValueError
        if token is not None:
            if not token or not preview["canConfirm"] or signing.loads(token, salt=SIGNING_SALT, max_age=PREVIEW_SECONDS) != payload:
                raise WritingImportError("INVALID_CONFIRMATION", "确认凭证无效，请重新预览。")
            preview["confirmationToken"] = token
        result = completed_import_result(preview, actor)
        if result:
            preview["result"] = result
        return preview
    except WritingImportError:
        raise
    except signing.SignatureExpired as error:
        raise WritingImportError("PREVIEW_EXPIRED", "确认凭证已过期，请重新上传预览。", 410) from error
    except FileNotFoundError as error:
        raise WritingImportError("PREVIEW_NOT_FOUND", "预览文件不存在或已清理，请重新上传。", 404) from error
    except (signing.BadSignature, ValueError, TypeError, KeyError, UnicodeError) as error:
        raise WritingImportError("PREVIEW_CONFLICT", "预览文件或凭证已变化，请重新上传核对。", 409) from error
    except OSError as error:
        raise WritingImportError("IMPORT_UNAVAILABLE", "预览文件暂不可读，请稍后重试。", 503) from error
    except DatabaseError as error:
        raise WritingImportError("IMPORT_UNAVAILABLE", "数据库暂不可用，请稍后按批次核对结果。", 503) from error


def cleanup_expired_previews():
    """Delete managed UUID directories older than 22h, preserving audit rows."""
    try:
        root = _root()
        if not root.exists():
            return 0
        cutoff = timezone.now().timestamp() - RETENTION_SECONDS
        deleted = 0
        for folder in root.iterdir():
            try:
                _preview_id(folder.name)
            except WritingImportError:
                continue
            if folder.is_symlink() or not folder.is_dir():
                continue
            # The directory timestamp is server-owned, so corrupt JSON cannot keep
            # abandoned imports indefinitely or cause deletion outside this root.
            if folder.stat().st_mtime <= cutoff:
                shutil.rmtree(folder)
                deleted += 1
        return deleted
    except OSError as error:
        raise WritingImportError("IMPORT_UNAVAILABLE", "过期导入文件清理失败，请检查私有目录。", 503) from error
