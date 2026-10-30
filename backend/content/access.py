"""All student content entrypoints share published snapshots and this policy."""

from django.db.models import F, Q, Subquery, Window
from django.db.models.functions import RowNumber

from .models import LearningConfiguration, Question, Source


def _published_conditions():
    return Q(
        published_revision__source=Source.LITERATURE,
        published_revision__type="fact",
        published_revision__category__is_active=True,
        published_revision__article__isnull=True,
    ) | Q(
        published_revision__source=Source.CLASSICAL,
        published_revision__article__is_active=True,
        published_revision__category__isnull=True,
    )


def _published_queryset(queryset):
    return queryset.filter(
        is_published=True,
        published_revision__isnull=False,
        published_revision__question_id=F("pk"),
    ).filter(_published_conditions())


def published_questions():
    return _published_queryset(Question.objects.all()).select_related(
        "published_revision", "published_revision__article"
    ).order_by("published_revision__sort_order", "pk")


def scope_questions(source, scope_id):
    fields = {Source.LITERATURE: "published_revision__category_id", Source.CLASSICAL: "published_revision__article_id"}
    if source not in fields:
        return published_questions().none()
    return published_questions().filter(published_revision__source=source, **{fields[source]: scope_id})


def free_question_ids(source, scope_id):
    size = LearningConfiguration.current().page_size
    return list(scope_questions(source, scope_id).values_list("pk", flat=True)[:size])


def _free_subquery(size):
    """Return the first ``size`` published questions per content scope.

    The previous correlated subquery ranked each candidate by re-scanning its
    entire scope. A window rank computes the same set in one pass while still
    ranking the unfiltered published set before callers apply type filters.
    """
    ranked = published_questions().annotate(
        _free_rank=Window(
            expression=RowNumber(),
            partition_by=[
                F("published_revision__source"),
                F("published_revision__category_id"),
                F("published_revision__article_id"),
            ],
            order_by=[
                F("published_revision__sort_order").asc(),
                F("pk").asc(),
            ],
        )
    ).filter(_free_rank__lte=size)
    return ranked.values("pk")


def free_questions(queryset=None, *, page_size=None):
    candidates = published_questions() if queryset is None else _published_queryset(queryset)
    size = LearningConfiguration.current().page_size if page_size is None else page_size
    return candidates.filter(pk__in=Subquery(_free_subquery(size)))


def has_full_access(user):
    if not user or not user.is_authenticated or not user.is_active:
        return False
    from entitlements.services import has_active_entitlement
    return has_active_entitlement(user)


def question_access(user, queryset=None, *, page_size=None):
    """One permission decision for both query construction and safe metadata."""
    candidates = published_questions() if queryset is None else _published_queryset(queryset)
    activated = has_full_access(user)
    if activated:
        return candidates, True
    return free_questions(candidates, page_size=page_size), False


def accessible_questions(user, queryset=None, *, page_size=None):
    return question_access(user, queryset, page_size=page_size)[0]


def can_access_question(user, question):
    question_id = getattr(question, "pk", question)
    # Re-fetch current publication. A cached/stale Question cannot authorize itself.
    return accessible_questions(user, published_questions().filter(pk=question_id)).exists()
