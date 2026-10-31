"""Fixed practice history; authorization always uses the current publication."""

import random
from types import SimpleNamespace

from django.db import transaction
from django.db.models import Subquery
from django.shortcuts import get_object_or_404

from common.errors import BusinessError
from common.idempotency import lookup, remember, require_key
from content.access import accessible_questions, published_questions, scope_questions
from content.models import Article, Category, LearningConfiguration
from content.serializers import StudentQuestionSerializer
from entitlements.services import lock_user
from learning.services import batch_question_states
from .models import PracticeRound, ResumePosition, RoundItem


MAX_ROUND_SIZE = 10000


def _student_lock(user):
    user = lock_user(user)
    if not user.is_active or user.is_staff or user.is_superuser:
        raise BusinessError("INVALID_TOKEN", "学员账户不可用。", 401)
    return user


def _scope_id(context):
    return context["categoryId"] if context["source"] == "literature" else context["articleId"]


def _scope_fields(context):
    return {"source": context["source"], "category_id": context["categoryId"],
            "article_id": context["articleId"], "question_type": context.get("type") or ""}


def scope_context(record):
    return {"source": record.source, "categoryId": record.category_id,
            "articleId": record.article_id, "type": record.question_type or None,
            "board": getattr(record, "position_kind", "sequence")}


def resume_scope_key(context):
    """Stable account-local key for one board/filter combination."""
    return ":".join(str(context.get(field) or "") for field in ("board", "source", "categoryId", "articleId", "type"))


def _query(context):
    scope_id = _scope_id(context)
    if scope_id is None:
        query = published_questions().filter(published_revision__source=context["source"])
    else:
        query = scope_questions(context["source"], scope_id)
    if context.get("type"):
        query = query.filter(published_revision__type=context["type"])
    return query


def _check_scope(context):
    scope_id = _scope_id(context)
    if scope_id is not None:
        model = Category if context["source"] == "literature" else Article
        get_object_or_404(model, pk=scope_id, is_active=True)


def round_metadata(round_):
    return {"id": str(round_.pk), "source": round_.source, "categoryId": round_.category_id,
            "articleId": round_.article_id, "type": round_.question_type or None, "mode": round_.mode,
            "pageSize": round_.group_size, "totalCount": round_.item_count,
            "groupCount": round_.group_count, "createdAt": round_.created_at.isoformat()}


@transaction.atomic
def create_round(user, payload, key):
    user = _student_lock(user)
    key = require_key(key)
    previous = lookup(user, "practice.round.create", key, payload)
    if previous:
        return previous.response
    _check_scope(payload)
    config = LearningConfiguration.current()
    query = _query(payload)
    questions = list(accessible_questions(user, query, page_size=config.page_size)[:MAX_ROUND_SIZE + 1])
    if len(questions) > MAX_ROUND_SIZE:
        raise BusinessError("ROUND_TOO_LARGE", "单次轮次最多 10,000 道题，请缩小范围。")
    if not questions:
        if query.exists():
            raise BusinessError("ENTITLEMENT_REQUIRED", "请先开通权益。", 403)
        raise BusinessError("NO_QUESTIONS", "此范围暂无已发布题目。", 404)
    random.SystemRandom().shuffle(questions)
    round_ = PracticeRound(user=user, **_scope_fields(payload), mode=payload["mode"],
                           group_size=config.page_size, item_count=len(questions))
    round_.save(_service=True)
    RoundItem.objects.bulk_create([
        RoundItem(round=round_, position=index, question=question, revision=question.published_revision)
        for index, question in enumerate(questions, 1)
    ], _service=True)
    result = round_metadata(round_)
    remember(user, "practice.round.create", key, payload, result)
    return result


def _owned_round(user, round_id):
    return get_object_or_404(PracticeRound, pk=round_id, user=user)


def _invalid_reason(context, question_id):
    # Diagnostics contain no protected content and do not grant access.
    if not published_questions().filter(pk=question_id).exists():
        return "UNAVAILABLE"
    if not _query(context).filter(pk=question_id).exists():
        return "SCOPE_CHANGED"
    return "ENTITLEMENT_REQUIRED"


def read_group(user, round_id, group_index):
    round_ = _owned_round(user, round_id)
    if not 1 <= group_index <= round_.group_count:
        raise BusinessError("NOT_FOUND", "组号不存在。", 404)
    first = (group_index - 1) * round_.group_size + 1
    items = list(round_.items.filter(position__gte=first, position__lt=first + round_.group_size)
                 .select_related("revision__article"))
    context = scope_context(round_)
    allowed = set(accessible_questions(user, _query(context).filter(pk__in=[item.question_id for item in items])).values_list("pk", flat=True))
    state_context = {"question_states": batch_question_states(user, allowed)}
    results, skipped = [], []
    for item in items:
        if item.question_id not in allowed or item.revision.question_id != item.question_id:
            reason = "UNAVAILABLE" if item.revision.question_id != item.question_id else _invalid_reason(context, item.question_id)
            skipped.append({"position": item.position, "reason": reason})
            continue
        # The historical revision is serialized only after CURRENT access in SQL.
        fixed = SimpleNamespace(id=item.question_id, published_revision=item.revision)
        results.append({**StudentQuestionSerializer(fixed, context=state_context).data,
                        "articleTitle": item.revision.article.title if item.revision.article_id else None,
                        "position": item.position})
    return {"roundId": str(round_.pk), "groupIndex": group_index,
            "groupCount": round_.group_count, "totalCount": round_.item_count,
            "pageSize": round_.group_size, "mode": round_.mode, "results": results, "skipped": skipped}


def _resume_data(position):
    return {**scope_context(position), "mode": position.mode, "questionId": position.question_id,
            "roundId": str(position.round_id) if position.round_id else None,
            "groupIndex": position.group_index, "scopeIndex": position.scope_index,
            "completed": bool(position.completed)}


def _round_context_matches(round_, context):
    return {key: scope_context(round_)[key] for key in ("source", "categoryId", "articleId", "type")} == {key: context.get(key) for key in ("source", "categoryId", "articleId", "type")}


def _random_item(round_, question_id, group_index):
    if not 1 <= group_index <= round_.group_count:
        return None
    item = round_.items.filter(question_id=question_id).first()
    if item is None or (item.position - 1) // round_.group_size + 1 != group_index:
        return None
    return item


def resume_snapshot(user, context=None):
    positions = ResumePosition.objects.filter(user=user).select_related("round", "question__published_revision")
    if context and context.get("source"):
        context = {key: context.get(key) for key in ("source", "categoryId", "articleId", "type", "board")}
        position = positions.filter(scope_key=resume_scope_key(context)).first()
    else:
        position = positions.order_by("-updated_at", "-pk").first()
    if position is None:
        return {"version": 0, "resume": None, "valid": False, "reason": "NO_RESUME", "start": None}
    context = scope_context(position)
    query = accessible_questions(user, _query(context))
    round_ = position.round
    random_valid = (position.position_kind == "sequence" and round_ is None) or (position.position_kind == "random" and round_ is not None and
        round_.user_id == user.pk and _round_context_matches(round_, context)
        and _random_item(round_, position.question_id, position.group_index) is not None
    )
    valid = random_valid and not position.completed and query.filter(pk=position.question_id).exists()
    reason = "COMPLETED" if position.completed else (None if valid else (_invalid_reason(context, position.question_id) if random_valid else "ROUND_UNAVAILABLE"))
    data = _resume_data(position)
    start = data.copy() if valid else None
    if not valid:
        if round_ is None and not position.completed:
            ids = list(query.values_list("pk", flat=True))
            if ids:
                index = min(max(int(position.scope_index or 0), 0), len(ids) - 1)
                start = {**data, "questionId": ids[index], "scopeIndex": index, "completed": False}
        elif random_valid and not position.completed:
            first_item = round_.items.filter(question_id__in=Subquery(query.values("pk"))).first()
            if first_item:
                start = {**data, "questionId": first_item.question_id,
                         "groupIndex": (first_item.position - 1) // round_.group_size + 1}
    return {"version": position.version, "resume": data, "valid": valid, "reason": reason, "start": start}


@transaction.atomic
def save_resume(user, payload, key):
    user = _student_lock(user)
    key = require_key(key)
    previous = lookup(user, "practice.resume.save", key, payload)
    if previous:
        return {**previous.response, "current": resume_snapshot(user, payload)}
    payload.setdefault("board", "random" if payload.get("roundId") else "sequence")
    context_key = resume_scope_key(payload)
    position = ResumePosition.objects.select_for_update().filter(user=user, scope_key=context_key).first()
    version = position.version if position else 0
    if payload["baseVersion"] != version:
        raise BusinessError("VERSION_CONFLICT", "续学位置已被其他设备更新。", 409,
                            fields={"current": resume_snapshot(user, payload)})
    _check_scope(payload)
    question = accessible_questions(user, _query(payload).filter(pk=payload["questionId"])).first()
    if question is None:
        reason = _invalid_reason(payload, payload["questionId"])
        if reason == "ENTITLEMENT_REQUIRED":
            raise BusinessError(reason, "请先开通权益。", 403)
        raise BusinessError("INVALID_CONTEXT", "题目已不可用或不属于此范围。", fields={"reason": reason})
    round_ = None
    if payload["roundId"]:
        round_ = _owned_round(user, payload["roundId"])
        if not _round_context_matches(round_, payload) or not _random_item(round_, question.pk, payload["groupIndex"]):
            raise BusinessError("INVALID_CONTEXT", "题目不属于此轮次、范围或组号。")
    if position is None:
        position = ResumePosition(user=user, scope_key=context_key)
    for field, value in _scope_fields(payload).items():
        setattr(position, field, value)
    position.mode, position.question, position.round = payload["mode"], question, round_
    position.position_kind = payload["board"]
    position.group_index = payload["groupIndex"]
    if round_ is not None:
        position.scope_index = max(0, (round_.items.get(question=question).position - 1))
    else:
        ids = list(_query(payload).values_list("pk", flat=True))
        try:
            position.scope_index = ids.index(question.pk)
        except ValueError:
            position.scope_index = 0
    position.completed = bool(payload.get("completed", False))
    position.version = version + 1
    position.save(_service=True)
    result = {"version": position.version, "resume": _resume_data(position)}
    remember(user, "practice.resume.save", key, payload, result)
    return {**result, "current": resume_snapshot(user, payload)}
