"""Read-only import plans and atomic, replay-safe draft imports."""

import hashlib
import json
from functools import wraps

from django.contrib.admin.models import CHANGE, LogEntry
from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.db import DatabaseError, IntegrityError, connection, transaction
from django.db.models import Q

from config.admin_navigation import is_agent_account
from .models import WritingCategory, WritingContent, WritingGenre


MODES = ("create_only", "upsert_draft")
FIELDS = ("category_id", "genre_id", "kind", "title", "body", "reference_answer", "sort_order")
LABELS = dict(zip(FIELDS, ("分类编号", "文种编号", "内容类型", "标题", "正文", "参考答案", "排序")))
AUDIT_KIND = "writing_import_v1"
# A database-wide import sequence also protects absent IDs and absent dictionary names
# between distinct batches. Existing rows still use row locks against normal editors.
IMPORT_LOCK = 0x57524954494E47


class WritingImportError(Exception):
    def __init__(self, code, message, status=400):
        self.code, self.message, self.status = code, message, status
        super().__init__(message)


def _database_guard(function):
    @wraps(function)
    def guarded(*args, **kwargs):
        try:
            return function(*args, **kwargs)
        except DatabaseError as error:
            raise WritingImportError("IMPORT_UNAVAILABLE", "数据库暂不可用，请稍后按批次核对结果。", 503) from error
    return guarded


def stable_digest(value):
    return hashlib.sha256(json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str,
    ).encode("utf-8")).hexdigest()


def _fresh_actor(actor):
    if not actor or not actor.is_authenticated or not actor.pk:
        return None
    # A fresh model instance is essential: Django caches permissions on request users.
    return get_user_model().objects.filter(pk=actor.pk, is_active=True, is_staff=True).first()


@_database_guard
def has_import_permission(actor):
    actor = _fresh_actor(actor)
    return bool(actor and not is_agent_account(actor) and actor.has_perms((
        "writing.view_writingcontent", "writing.add_writingcontent",
    )))


@_database_guard
def require_import_permission(actor, preview=None):
    actor = _fresh_actor(actor)
    if not actor or is_agent_account(actor) or not actor.has_perms((
        "writing.view_writingcontent", "writing.add_writingcontent",
    )):
        raise WritingImportError("PERMISSION_DENIED", "当前账户没有应用文导入权限，请联系管理员分配查看和新增权限。", 403)
    if preview:
        permissions = []
        plan = preview.get("plan", {})
        if any(row.get("action") == "update" for row in plan.get("contents", [])):
            permissions.append("writing.change_writingcontent")
        for key, model_name in (("categories", "writingcategory"), ("genres", "writinggenre")):
            if any(row.get("action") == "create" for row in plan.get(key, [])):
                permissions.extend((f"writing.view_{model_name}", f"writing.add_{model_name}"))
        if not actor.has_perms(permissions):
            raise WritingImportError("PERMISSION_DENIED", "当前账户缺少本批修改内容或新增分类、文种所需的权限，请联系管理员。", 403)
    return actor


def _normalize(values):
    result = {"id": values["id"], **{field: values[field] for field in FIELDS}}
    result["genre_id"] = result["genre_id"] or None
    result["title"] = result["title"].strip()
    result["kind"] = result["kind"].strip()
    for field in ("body", "reference_answer"):
        result[field] = (result[field] or "").replace("\r\n", "\n").replace("\r", "\n")
    return result


def _content_fingerprint(item):
    return stable_digest({
        "id": item.pk, **item.content_payload(), "is_published": item.is_published,
        "published_revision_id": item.published_revision_id, "updated_at": item.updated_at,
    })


def _dictionary_fingerprint(item):
    return stable_digest({"id": item.pk, "name": item.name, "sort_order": item.sort_order, "is_active": item.is_active})


def _issue(issues, sheet, row, column, code, message):
    issues.append({"sheet": sheet, "row": row, "column": column, "code": code, "message": message})


def _snapshot(parsed, *, lock=False):
    contents = parsed.get("contents", [])
    content_ids = [row["values"]["id"] for row in contents]
    content_query = WritingContent.objects.filter(pk__in=content_ids).order_by("pk")
    if lock:
        content_query = content_query.select_for_update()
    existing = {item.pk: item for item in content_query}
    dictionaries, dependencies = {}, {"contents": {
        pk: _content_fingerprint(existing[pk]) if pk in existing else None for pk in sorted(set(content_ids))
    }}
    for key, field, model in (("categories", "category_id", WritingCategory), ("genres", "genre_id", WritingGenre)):
        rows = parsed.get(key, [])
        ids = {row["values"]["id"] for row in rows}
        ids.update(row["values"].get(field) for row in contents if row["values"].get(field))
        names = {row["values"]["name"] for row in rows}
        query = model.objects.filter(Q(pk__in=ids) | Q(name__in=names)).order_by("pk")
        if lock:
            query = query.select_for_update()
        found = {item.pk: item for item in query}
        dictionaries[key] = found
        dependencies[key] = {pk: _dictionary_fingerprint(found[pk]) if pk in found else None for pk in sorted(ids)}
        dependencies[key + "Names"] = {name: [
            {"id": item.pk, "fingerprint": _dictionary_fingerprint(item)}
            for item in found.values() if item.name == name
        ] for name in sorted(names)}
    return existing, dictionaries, dependencies


@_database_guard
def build_import_preview(parsed, actor, mode):
    actor = require_import_permission(actor)
    if mode not in MODES:
        raise WritingImportError("INVALID_MODE", "请选择“仅新增”或“新增及更新草稿”模式。")
    issues = [dict(issue) for issue in parsed.get("issues", [])]
    existing, dictionaries, dependencies = _snapshot(parsed)
    plan = {"contents": [], "categories": [], "genres": []}
    usable = {}
    for key, field, sheet in (("categories", "category_id", "分类"), ("genres", "genre_id", "文种")):
        found = dictionaries[key]
        usable[key] = {pk for pk, item in found.items() if item.is_active}
        referenced = {row["values"].get(field) for row in parsed.get("contents", [])}
        seen_ids, seen_names = set(), {}
        for row in parsed.get(key, []):
            value = dict(row["values"])
            pk, name = value["id"], value["name"]
            before = len(issues)
            if pk in seen_ids:
                _issue(issues, sheet, row["row"], sheet + "编号", "DUPLICATE_ID", "编号重复，请删除重复行。")
            seen_ids.add(pk)
            item = found.get(pk)
            if item:
                if not item.is_active:
                    _issue(issues, sheet, row["row"], sheet + "编号", "RELATED_DISABLED", "该字典项已停用，请先在管理页核对。")
                if item.name != name or item.sort_order != value["sort_order"]:
                    _issue(issues, sheet, row["row"], sheet + "编号", "DICTIONARY_CONFLICT", "已有编号的名称或排序不同，请先在字典管理页修改。")
                action = "unchanged"
            else:
                action = "create"
                same_name = [obj.pk for obj in found.values() if obj.name == name]
                if same_name or name in seen_names:
                    _issue(issues, sheet, row["row"], sheet + "名称", "DICTIONARY_CONFLICT", "已有相同名称的其他编号，请复用已有编号。")
                if pk not in referenced:
                    _issue(issues, sheet, row["row"], sheet + "编号", "UNREFERENCED_DICTIONARY", "新增字典项没有被应用文引用，请删除该行或补齐引用。")
                if len(issues) == before:
                    usable[key].add(pk)
            seen_names[name] = pk
            plan[key].append({"row": row["row"], "values": value, "action": action})

    rows, seen_ids = [], set()
    counts = {"create": 0, "update": 0, "unchanged": 0, "errors": 0}
    for row in parsed.get("contents", []):
        values = _normalize(row["values"])
        pk = values["id"]
        before = len(issues)
        if pk in seen_ids:
            _issue(issues, "应用文", row["row"], "内容编号", "DUPLICATE_ID", "内容编号重复，请删除重复行。")
        seen_ids.add(pk)
        for key, field, label in (("categories", "category_id", "分类"), ("genres", "genre_id", "文种")):
            related = values[field]
            if related and related not in usable[key]:
                item = dictionaries[key].get(related)
                code = "RELATED_DISABLED" if item and not item.is_active else "RELATED_NOT_FOUND"
                _issue(issues, "应用文", row["row"], LABELS[field], code, f"{label}不存在、未启用或本次新增无效，请填写有效编号。")
        item = existing.get(pk)
        old = _normalize({"id": pk, **item.content_payload()}) if item else None
        changes = [{"field": field, "label": LABELS[field], "before": old[field] if old else None, "after": values[field]}
                   for field in FIELDS if old is None or old[field] != values[field]]
        action = "create" if item is None else ("update" if changes else "unchanged")
        if action == "update" and mode == "create_only":
            _issue(issues, "应用文", row["row"], "内容编号", "EXISTING_CONTENT_CONFLICT", "已有编号的内容不同，请改用“新增及更新草稿”或修正编号。")
        if len(issues) > before or any(issue.get("sheet") == "应用文" and issue.get("row") == row["row"] for issue in issues):
            action = "error"
        if action in counts:
            counts[action] += 1
        rows.append({"sheet": "应用文", "row": row["row"], "id": pk, "title": values["title"],
                     "action": action, "values": values, "changes": changes})
        plan["contents"].append({"row": row["row"], "values": values, "action": action})
    if not parsed.get("contents") and not issues:
        _issue(issues, "应用文", None, None, "EMPTY_WORKBOOK", "请至少填写一条应用文内容。")
    counts["errors"] = len(issues)
    preview = {
        "owner": str(actor.pk), "mode": mode, "counts": counts, "issues": issues,
        "dictionaries": {"categoriesToCreate": sum(row["action"] == "create" for row in plan["categories"]),
                         "genresToCreate": sum(row["action"] == "create" for row in plan["genres"])},
        "rows": rows, "plan": plan, "dependencies": dependencies, "canConfirm": not issues,
    }
    require_import_permission(actor, preview)
    return preview


@_database_guard
def completed_import_result(preview, actor):
    """Read the transaction's durable completion marker, never a filesystem flag."""
    marker = LogEntry.objects.filter(content_type__isnull=True, object_id=preview["previewId"],
                                     user_id=actor.pk, object_repr=AUDIT_KIND).first()
    if not marker:
        return None
    try:
        message = json.loads(marker.change_message)
        if (message["kind"] != AUDIT_KIND or message["fileDigest"] != preview["fileDigest"]
                or message["planDigest"] != preview["planDigest"]):
            raise ValueError
        return {**message["result"], "status": "already_completed"}
    except (KeyError, TypeError, ValueError) as error:
        raise WritingImportError("PREVIEW_CONFLICT", "本批审计结果异常，请联系管理员核对批次。", 409) from error


def _lock_dictionary_tables(preview):
    if connection.vendor != "postgresql" or not any(
        row["action"] == "create" for key in ("categories", "genres") for row in preview["plan"][key]
    ):
        return
    # Missing names have no rows to lock. Ordinary dictionary admin writes do not
    # take our advisory lock; table locks stabilize this predicate until commit.
    tables = ", ".join(connection.ops.quote_name(model._meta.db_table) for model in (WritingCategory, WritingGenre))
    with connection.cursor() as cursor:
        cursor.execute(f"LOCK TABLE {tables} IN SHARE ROW EXCLUSIVE MODE")


@_database_guard
def confirm_import(preview, actor):
    # Always reload the private signed plan; a caller-supplied Python dict is not proof.
    from .import_storage import load_preview
    token = preview.get("confirmationToken")
    if not token:
        raise WritingImportError("INVALID_CONFIRMATION", "确认凭证缺失，请重新预览后确认。")
    preview = load_preview(preview.get("previewId"), actor, token=token)
    actor = require_import_permission(actor, preview)
    if not preview.get("canConfirm") or preview.get("issues"):
        raise WritingImportError("INVALID_PREVIEW", "预览存在错误，请修正表格后重新上传。")
    try:
        with transaction.atomic():
            if connection.vendor == "postgresql":
                with connection.cursor() as cursor:
                    cursor.execute("SELECT pg_advisory_xact_lock(%s)", [IMPORT_LOCK])
            actor = require_import_permission(actor, preview)
            completed = completed_import_result(preview, actor)
            if completed:
                return completed
            _lock_dictionary_tables(preview)
            parsed = {key: [{"row": row["row"], "values": row["values"]} for row in preview["plan"][key]]
                      for key in ("contents", "categories", "genres")}
            _existing, _dictionaries, dependencies = _snapshot(parsed, lock=True)
            if dependencies != preview["dependencies"]:
                raise WritingImportError("PREVIEW_CONFLICT", "应用文、发布状态或分类文种已变化，请重新上传预览。", 409)
            fresh = build_import_preview(parsed, actor, preview["mode"])
            if not fresh["canConfirm"] or fresh["plan"] != preview["plan"]:
                raise WritingImportError("PREVIEW_CONFLICT", "本批数据已变化，请重新上传预览。", 409)
            for key, model in (("categories", WritingCategory), ("genres", WritingGenre)):
                for row in preview["plan"][key]:
                    if row["action"] == "create":
                        model(**row["values"], is_active=True).save(force_insert=True)
            for row in preview["plan"]["contents"]:
                if row["action"] == "create":
                    WritingContent(**row["values"], is_published=False, published_revision=None).save(force_insert=True)
                elif row["action"] == "update":
                    item = _existing[row["values"]["id"]]
                    for field in FIELDS:
                        setattr(item, field, row["values"][field])
                    item.save(update_fields=(*FIELDS, "updated_at"))
            result = {"batchId": preview["previewId"], "status": "completed", "counts": {
                "created": fresh["counts"]["create"], "updated": fresh["counts"]["update"],
                "unchanged": fresh["counts"]["unchanged"],
            }, "contentIds": [row["values"]["id"] for row in preview["plan"]["contents"]], "published": False}
            LogEntry.objects.create(
                user_id=actor.pk, content_type=None, object_id=preview["previewId"], object_repr=AUDIT_KIND,
                action_flag=CHANGE, change_message=json.dumps({
                    "kind": AUDIT_KIND, "mode": preview["mode"], "fileDigest": preview["fileDigest"],
                    "planDigest": preview["planDigest"], "result": result,
                    "changedIds": [row["values"]["id"] for row in preview["plan"]["contents"] if row["action"] in ("create", "update")],
                }, ensure_ascii=False),
            )
            return result
    except WritingImportError:
        raise
    except (IntegrityError, ValidationError) as error:
        raise WritingImportError("PREVIEW_CONFLICT", "编号已被占用或本批数据已变化，整批未导入，请重新预览。", 409) from error
    except DatabaseError as error:
        raise WritingImportError("IMPORT_UNAVAILABLE", "数据库暂不可用，请按批次核对结果后重试。", 503) from error
