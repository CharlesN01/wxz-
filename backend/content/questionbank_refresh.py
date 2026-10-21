"""Atomic, reviewed full-bank replacement without deleting learning references."""

import json
import os
from pathlib import Path
import re
import tempfile

from django.contrib.admin.models import CHANGE, LogEntry
from django.contrib.contenttypes.models import ContentType
from django.core.exceptions import PermissionDenied, ValidationError
from django.db import connection, transaction
from django.utils import timezone

from .models import Article, Category, Question
from .services import publish_questions, require_publish_permission, unpublish_questions


CONTENT_FIELDS = ("source", "type", "tag", "stem", "answers", "sort_order", "category_id", "article_id")
STATE_FIELDS = ("id", *CONTENT_FIELDS, "is_published", "published_revision_id")
DIRECTORY_FIELDS = {
    "categories": (Category, ("id", "name", "sort_order", "is_active")),
    "articles": (Article, ("id", "title", "sort_order", "is_active")),
}


def load_bundle(raw):
    try:
        bundle = json.loads(raw)
    except (ValueError, TypeError) as error:
        raise ValidationError("题库包不是有效 JSON。") from error
    if not isinstance(bundle, dict) or bundle.get("schema") != "chinese-study-questionbank-v1":
        raise ValidationError("题库包版本不支持。")
    if bundle.get("scope_sources") != ["literature", "classical"]:
        raise ValidationError("本命令仅支持明确替换文学常识和文言文两个题库。")
    questions, files = bundle.get("questions"), bundle.get("source_files")
    if not isinstance(questions, list) or not 1 <= len(questions) <= 20000 or not isinstance(files, list) or len(files) != 3:
        raise ValidationError("题库行数或来源文件数量无效。")
    counts = {}
    for source in files:
        if (
            not isinstance(source, dict) or not isinstance(source.get("name"), str)
            or source["name"] in counts or not re.fullmatch(r"[a-f0-9]{64}", source.get("sha256", ""))
            or not isinstance(source.get("count"), int) or source["count"] <= 0
        ):
            raise ValidationError("原始工作簿清单或 SHA-256 无效。")
        counts[source["name"]] = source["count"]
    ids, provenance = set(), set()
    for row in questions:
        if not isinstance(row, dict) or set(STATE_FIELDS[:9]) - row.keys():
            raise ValidationError("题目字段缺失。")
        qid, filename, number = row.get("id"), row.get("source_file"), row.get("source_row")
        source_id = row.get("source_id")
        if (
            not isinstance(qid, str) or not re.fullmatch(r"[-A-Za-z0-9_]{1,64}", qid) or qid in ids
            or filename not in counts or not isinstance(number, int) or number < 2
            or not isinstance(source_id, str) or not re.fullmatch(r"[-A-Za-z0-9_]{1,64}", source_id)
            or (filename, number) in provenance
        ):
            raise ValidationError("题号、工作簿或来源行无效/重复。")
        ids.add(qid)
        provenance.add((filename, number))
    for filename, count in counts.items():
        if {number for name, number in provenance if name == filename} != set(range(2, count + 2)):
            raise ValidationError(f"{filename} 的来源行数不连续，禁止漏行导入。")
    baseline = bundle.get("baseline_questions")
    if not isinstance(baseline, list) or any(not isinstance(row, dict) or set(row) != set(STATE_FIELDS) for row in baseline):
        raise ValidationError("缺少完整生产基线，禁止覆盖导入。")
    if len({row["id"] for row in baseline}) != len(baseline):
        raise ValidationError("生产基线题号重复。")
    for name, (model, fields) in DIRECTORY_FIELDS.items():
        rows = bundle.get(name)
        if not isinstance(rows, list) or any(not isinstance(row, dict) or set(row) != set(fields) for row in rows):
            raise ValidationError("目录字段不完整。")
        if len({row["id"] for row in rows}) != len(rows):
            raise ValidationError("目录题号重复。")
        for row in rows:
            model(**row).full_clean(validate_unique=False, validate_constraints=False)
    category_ids = {row["id"] for row in bundle["categories"] if row["is_active"]}
    article_ids = {row["id"] for row in bundle["articles"] if row["is_active"]}
    for row in questions:
        if row["source"] not in bundle["scope_sources"]:
            raise ValidationError("题目来源超出替换范围。")
        if (row.get("category_id") and row["category_id"] not in category_ids) or (row.get("article_id") and row["article_id"] not in article_ids):
            raise ValidationError(f"{row['id']} 引用了缺失或未启用目录。")
        question = Question(id=row["id"], **{key: row[key] for key in CONTENT_FIELDS})
        # Validate all content using the real model, with FK existence checked
        # against the in-memory complete directory above (avoids 20k SQL reads).
        question.full_clean(exclude=("category", "article", "published_revision"), validate_unique=False, validate_constraints=False)
    return bundle


def read_state(*, lock=False):
    queries = {}
    query = Question.objects.order_by("pk")
    if lock:
        query = query.select_for_update()
    queries["questions"] = list(query.values(*STATE_FIELDS))
    for name, (model, fields) in DIRECTORY_FIELDS.items():
        query = model.objects.order_by("pk")
        if lock:
            query = query.select_for_update()
        queries[name] = list(query.values(*fields))
    return queries


def lock_content_tables():
    if connection.vendor == "postgresql":
        # The complete replacement must also exclude concurrent *new* rows.
        # Ordinary SELECTs stay available; content edits wait for this short CLI
        # transaction. Row locks alone cannot prevent those phantom inserts.
        with connection.cursor() as cursor:
            names = ", ".join(connection.ops.quote_name(model._meta.db_table) for model in (Question, Category, Article))
            cursor.execute(f"LOCK TABLE {names} IN EXCLUSIVE MODE")


def state_map(rows):
    return {row["id"]: row for row in rows}


def make_plan(bundle, before):
    existing = state_map(before["questions"])
    wanted = state_map(bundle["questions"])
    new, updated, unchanged, publish = [], [], [], []
    for qid, row in wanted.items():
        old = existing.get(qid)
        if old is None:
            new.append(qid)
        elif any(row[key] != old[key] for key in CONTENT_FIELDS):
            updated.append(qid)
        else:
            unchanged.append(qid)
        if old is None or not old["is_published"] or qid in updated:
            publish.append(qid)
    archive = [qid for qid, row in existing.items() if row["source"] in bundle["scope_sources"] and qid not in wanted and row["is_published"]]
    return {"total": len(wanted), "new": new, "updated": updated, "unchanged": unchanged, "publish": publish, "archive": archive}


def check_baseline(bundle, before, plan):
    # A fully applied identical bundle is an intentional no-op, even though the
    # publication revisions have moved beyond its original production snapshot.
    if not (plan["new"] or plan["updated"] or plan["publish"] or plan["archive"]):
        return
    baseline = state_map(bundle["baseline_questions"])
    current = state_map([row for row in before["questions"] if row["source"] in bundle["scope_sources"]])
    if baseline != current:
        raise ValidationError("当前题库与预检生产快照不一致；请重新导出快照并生成题库包，不覆盖期间的人工修改。")
    for name in DIRECTORY_FIELDS:
        if state_map(before[name]) != state_map(bundle[name]):
            raise ValidationError("当前分类/篇目与预检快照不一致，请重新生成题库包。")


def require_actor(actor):
    require_publish_permission(actor)
    if not actor.has_perm("content.import_question") or not actor.has_perm("content.change_question"):
        raise PermissionDenied("需要题目导入、编辑、发布权限。")


def write_backup(path, payload):
    target = Path(path).resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temp_path = tempfile.mkstemp(prefix=".questionbank-backup-", dir=target.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        # Atomic exclusive creation: a complete recovery point becomes visible
        # at once, and an existing file can never be replaced, even in a race.
        os.link(temp_path, target)
    finally:
        Path(temp_path).unlink(missing_ok=True)


@transaction.atomic
def apply_bundle(bundle, *, actor, backup_path):
    require_actor(actor)
    lock_content_tables()
    before = read_state(lock=True)
    plan = make_plan(bundle, before)
    check_baseline(bundle, before, plan)
    if not (plan["new"] or plan["updated"] or plan["publish"] or plan["archive"]):
        return plan
    # Directory edits/creation are deliberately excluded: this replacement is
    # reviewed against the existing eight categories and 25 published articles.
    by_id = state_map(bundle["questions"])
    create = [Question(id=qid, **{key: by_id[qid][key] for key in CONTENT_FIELDS}) for qid in plan["new"]]
    Question.objects.bulk_create(create, batch_size=500)
    now = timezone.now()
    for qid in plan["updated"]:
        Question.objects.filter(pk=qid).update(**{key: by_id[qid][key] for key in CONTENT_FIELDS}, updated_at=now)
    unpublish_questions(Question.objects.filter(pk__in=plan["archive"]), actor)
    publish_questions(Question.objects.filter(pk__in=plan["publish"]), actor)
    after = read_state()
    write_backup(backup_path, {
        "schema": "chinese-study-questionbank-rollback-v1", "before": before, "after": after,
        "created_at": now.isoformat(), "new_ids": plan["new"],
    })
    LogEntry.objects.create(
        user_id=actor.pk, content_type=ContentType.objects.get_for_model(Question),
        object_id="", object_repr="新版题库完整替换", action_flag=CHANGE,
        change_message=json.dumps({key: len(value) if isinstance(value, list) else value for key, value in plan.items()}, ensure_ascii=False),
    )
    return plan


@transaction.atomic
def restore_backup(data, *, actor):
    require_actor(actor)
    lock_content_tables()
    if data.get("schema") != "chinese-study-questionbank-rollback-v1":
        raise ValidationError("不支持此回滚文件。")
    current = read_state(lock=True)
    before, after = data["before"], data["after"]
    restored = {**after, "questions": [dict(row) for row in after["questions"]]}
    old_by_id = state_map(before["questions"])
    for row in restored["questions"]:
        if row["id"] in old_by_id:
            row.update(old_by_id[row["id"]])
        elif row["id"] in data["new_ids"]:
            row["is_published"] = False
    if current == restored:
        return 0
    if current != after:
        raise ValidationError("导入后题库已有人工修改/其他批次，禁止覆盖回滚；请人工核对或使用数据库备份。")
    now = timezone.now()
    for row in before["questions"]:
        Question.objects.filter(pk=row["id"]).update(**{key: row[key] for key in STATE_FIELDS if key != "id"}, updated_at=now)
    # New rows/revisions may already be referenced by learners. Retain all of
    # them and their histories, withdrawing access rather than deleting them.
    Question.objects.filter(pk__in=data["new_ids"]).update(is_published=False, updated_at=now)
    LogEntry.objects.create(
        user_id=actor.pk, content_type=ContentType.objects.get_for_model(Question),
        object_id="", object_repr="回滚新版题库发布", action_flag=CHANGE,
        change_message="恢复旧题草稿/发布指针，新题下架；全部题目、修订及学员记录保留。",
    )
    return len(before["questions"])
