"""Explicit versioned writes serialized by the authenticated User row."""

from datetime import datetime, time, timedelta
from zoneinfo import ZoneInfo

from django.db import transaction
from django.db.models import Count, Exists, Max, OuterRef, Q, Sum
from django.utils import timezone

from common.errors import BusinessError
from common.idempotency import lookup, remember
from content.models import Question, Source
from entitlements.services import lock_user
from .models import LearningActivity, LearningPreference, QuestionState, StudyTimeDaily, StudyTimeHeartbeat, StudyTimeSession


SHANGHAI = ZoneInfo("Asia/Shanghai")


def shanghai_today():
    return timezone.now().astimezone(SHANGHAI).date()


def state_snapshot(state, question_id):
    return {"questionId": str(question_id), "favorite": state.favorite if state else False,
            "mastered": state.mastered if state else False, "version": state.version if state else 0}


def batch_question_states(user, question_ids):
    """Read one already-authorized page/group without creating empty state rows."""
    if not user or not user.is_authenticated:
        return None
    ids = list(question_ids)
    states = {state.question_id: state for state in QuestionState.objects.filter(user=user, question_id__in=ids)}
    return {str(question_id): state_snapshot(states.get(question_id), question_id) for question_id in ids}


def preference_snapshot(user):
    from content.models import LearningConfiguration
    preference = LearningPreference.objects.filter(user=user).first()
    return {"mode": preference.mode if preference else "writing",
            "dailyTarget": preference.daily_target if preference else LearningConfiguration.current().daily_target,
            "version": preference.version if preference else 0}


def check_version(expected, current):
    if expected != current["version"]:
        raise BusinessError("VERSION_CONFLICT", "学习记录已更新，请同步后重试。", 409, fields={"current": current})


def _active_user(user):
    locked = lock_user(user)
    if not locked.is_active or locked.is_staff or locked.is_superuser:
        raise BusinessError("INVALID_TOKEN", "学员账号已不可用，请重新登录。", 401)
    return locked


def read_question_state(user, question_id):
    from content.access import can_access_question
    state = QuestionState.objects.filter(user=user, question_id=question_id).first()
    if state:
        return state_snapshot(state, question_id)
    question = Question.objects.only("id").filter(pk=question_id).first()
    if question is None:
        raise BusinessError("NOT_FOUND", "题目不存在。", 404)
    if not can_access_question(user, question):
        raise BusinessError("ENTITLEMENT_REQUIRED", "该题当前不可访问。", 403)
    return state_snapshot(None, question_id)


@transaction.atomic
def update_question_state(user, question_id, payload, key):
    from content.access import can_access_question
    user = _active_user(user)
    request_payload = {"questionId": str(question_id), **payload}
    replay = lookup(user, "learning-question-state", key, request_payload)
    if replay:
        return replay.response
    question = Question.objects.only("id").filter(pk=question_id).first()
    if question is None:
        raise BusinessError("NOT_FOUND", "题目不存在。", 404)
    state = QuestionState.objects.select_for_update().filter(user=user, question=question).first()
    current = state_snapshot(state, question_id)
    check_version(payload["baseVersion"], current)
    new_true = any(payload.get(field) is True and not current[field] for field in ("favorite", "mastered"))
    if (state is None or new_true) and not can_access_question(user, question):
        raise BusinessError("ENTITLEMENT_REQUIRED", "该题当前不可访问，不能新增学习状态。", 403)
    state = state or QuestionState(user=user, question=question)
    was_mastered = state.mastered
    if "favorite" in payload and payload["favorite"] != state.favorite:
        state.favorited_at = timezone.now() if payload["favorite"] else None
    for field in ("favorite", "mastered"):
        if field in payload:
            setattr(state, field, payload[field])
    state.version += 1
    state.save()
    if not was_mastered and state.mastered:
        LearningActivity.objects.get_or_create(user=user, question=question, study_date=shanghai_today())
    response = state_snapshot(state, question_id)
    remember(user, "learning-question-state", key, request_payload, response)
    return response


@transaction.atomic
def update_preferences(user, payload, key):
    from content.models import LearningConfiguration
    user = _active_user(user)
    replay = lookup(user, "learning-preferences", key, payload)
    if replay:
        return replay.response
    current = preference_snapshot(user)
    check_version(payload["baseVersion"], current)
    preference = LearningPreference.objects.select_for_update().filter(user=user).first()
    preference = preference or LearningPreference(user=user, daily_target=LearningConfiguration.current().daily_target)
    if "mode" in payload:
        preference.mode = payload["mode"]
    if "dailyTarget" in payload:
        preference.daily_target = payload["dailyTarget"]
    preference.version += 1
    preference.save()
    response = {"mode": preference.mode, "dailyTarget": preference.daily_target, "version": preference.version}
    remember(user, "learning-preferences", key, payload, response)
    return response


def statistics(user):
    from content.access import published_questions
    published = published_questions().annotate(learned=Exists(
        QuestionState.objects.filter(user=user, mastered=True, question_id=OuterRef("pk")),
    ))
    counts = published.aggregate(total=Count("pk"), mastered=Count("pk", filter=Q(learned=True)))
    total, mastered_count = counts["total"], counts["mastered"]
    activities = LearningActivity.objects.filter(user=user)
    articles = published.filter(published_revision__source=Source.CLASSICAL).order_by().values(
        "published_revision__article_id",
    ).annotate(total=Count("pk"), mastered=Count("pk", filter=Q(learned=True)))
    completed = sum(1 for item in articles if item["total"] > 0 and item["mastered"] == item["total"])
    today = shanghai_today()
    timing = study_time_statistics(user, today=today)
    activity_days = set(activities.filter(study_date__lte=today).order_by().values_list("study_date", flat=True).distinct())
    timed_days = set(StudyTimeDaily.objects.filter(user=user, study_seconds__gt=0, study_date__lte=today).values_list("study_date", flat=True))
    active_days = activity_days | timed_days
    cursor = today if today in active_days else today - timedelta(days=1)
    consecutive = 0
    while cursor in active_days:
        consecutive += 1
        cursor -= timedelta(days=1)
    return {
        "totalQuestions": total, "masteredQuestions": mastered_count,
        "masteredPercent": round(mastered_count * 100 / total, 2) if total else 0,
        "todayQuestions": activities.filter(study_date=today).count(),
        "studyDays": len(active_days), "consecutiveStudyDays": consecutive,
        "completedArticles": completed, "dailyTarget": preference_snapshot(user)["dailyTarget"],
        **timing,
    }


def study_time_statistics(user, *, today=None):
    today = today or shanghai_today()
    start = today - timedelta(days=6)
    activity = dict(LearningActivity.objects.filter(user=user, study_date__range=(start, today))
                    .order_by().values("study_date").annotate(total=Count("pk"))
                    .values_list("study_date", "total"))
    daily_time = dict(StudyTimeDaily.objects.filter(user=user, study_date__range=(start, today))
                      .values_list("study_date", "study_seconds"))
    previous = StudyTimeDaily.objects.filter(
        user=user, study_date__range=(start - timedelta(days=7), start - timedelta(days=1)),
    ).aggregate(total=Sum("study_seconds"))["total"] or 0
    return {
        "todayStudySeconds": daily_time.get(today, 0),
        "currentPeriodStudySeconds": sum(daily_time.values()),
        "previousPeriodStudySeconds": previous,
        "dailyTrend": [{"date": (day := start + timedelta(days=offset)).isoformat(),
                        "questionCount": activity.get(day, 0), "studySeconds": daily_time.get(day, 0),
                        "isToday": day == today}
                       for offset in range(7)],
    }


def _credit_study_interval(user, start, end):
    """Persist only server-bounded credited seconds, split at Shanghai midnight."""
    cursor = start
    while cursor < end:
        day = cursor.astimezone(SHANGHAI).date()
        midnight = datetime.combine(day + timedelta(days=1), time.min, tzinfo=SHANGHAI)
        boundary = min(end, midnight)
        seconds = int((boundary - cursor).total_seconds())
        if seconds:
            daily, _created = StudyTimeDaily.objects.get_or_create(user=user, study_date=day)
            daily.study_seconds += seconds
            daily.save(update_fields=("study_seconds", "updated_at"))
        cursor = boundary


@transaction.atomic
def record_study_time(user, payload):
    """A UUID/sequence pair is the request identity, independent of Bearer refresh.

    The authenticated user lock serializes sessions and prevents overlapping
    devices from claiming the same wall-clock interval more than once. A long
    background/offline gap earns at most the final 30 reported active seconds.
    """
    user = _active_user(user)
    now = timezone.now()
    session_id = payload["sessionId"]
    sequence, elapsed = payload["sequence"], payload["elapsedSeconds"]
    session = StudyTimeSession.objects.select_for_update().filter(user=user, session_id=session_id).first()
    if session:
        previous = StudyTimeHeartbeat.objects.filter(session=session, sequence=sequence).first()
        if previous:
            if previous.elapsed_seconds != elapsed:
                raise BusinessError("STUDY_TIME_SEQUENCE_CONFLICT", "同一心跳序号不能用于不同内容。", 409,
                                    fields={"expectedSequence": session.last_sequence + 1})
            return previous.response
        if sequence != session.last_sequence + 1:
            raise BusinessError("STUDY_TIME_SEQUENCE_CONFLICT", "学习计时序号不连续，请重试原请求。", 409,
                                fields={"expectedSequence": session.last_sequence + 1})
    elif sequence != 0 or elapsed != 0:
        raise BusinessError("STUDY_TIME_ANCHOR_REQUIRED", "请先建立学习计时会话。", 409,
                            fields={"expectedSequence": 0})

    credit = 0
    if session:
        gap = max(0, (now - session.last_received_at).total_seconds())
        credit = min(elapsed, int(gap), 30 if gap > 90 else 60)
        credit_end = now.replace(microsecond=0)
        # Exclude time already credited to another client/session for this user.
        credited_until = StudyTimeSession.objects.filter(user=user).aggregate(latest=Max("credited_until"))["latest"]
        if credited_until:
            credit = min(credit, max(0, int((credit_end - credited_until).total_seconds())))
        if credit:
            _credit_study_interval(user, credit_end - timedelta(seconds=credit), credit_end)
            session.credited_until = credit_end
        session.last_sequence = sequence
        session.last_received_at = max(now, session.last_received_at)
        session.save(update_fields=("last_sequence", "last_received_at", "credited_until"))
    else:
        session = StudyTimeSession.objects.create(user=user, session_id=session_id, last_received_at=now)

    today = now.astimezone(SHANGHAI).date()
    today_seconds = StudyTimeDaily.objects.filter(user=user, study_date=today).values_list("study_seconds", flat=True).first() or 0
    response = {"sessionId": str(session_id), "sequence": sequence, "nextSequence": sequence + 1,
                "creditedSeconds": credit, "todayStudySeconds": today_seconds, "studyDate": today.isoformat(),
                "serverTime": now.isoformat()}
    StudyTimeHeartbeat.objects.create(session=session, sequence=sequence, elapsed_seconds=elapsed,
                                     credited_seconds=credit, response=response)
    return response
