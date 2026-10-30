"""Read-only student content; protected answers never depend on client masking."""

from django.db.models import Count, Exists, F, IntegerField, OuterRef, Q, Subquery, Value, Window
from django.db.models.functions import Coalesce, Least, RowNumber
from django.http import Http404
from django.shortcuts import get_object_or_404
from django.utils.cache import patch_vary_headers
from rest_framework import serializers
from rest_framework.pagination import PageNumberPagination
from rest_framework.response import Response

from common.api import PublicStudentAPIView
from common import content_cache
from common.errors import BusinessError
from .access import (
    accessible_questions,
    free_questions,
    has_full_access,
    published_questions,
    question_access,
    scope_questions,
)
from .models import Article, Category, LearningConfiguration
from .serializers import StudentQuestionSerializer, StrictPositiveIntegerField, validate_query_params


class EmptyQuery(serializers.Serializer):
    pass


class StudentPageQuery(serializers.Serializer):
    page = StrictPositiveIntegerField(min_value=1, max_value=1000000, required=False)


class StudentQuestionQuery(StudentPageQuery):
    source = serializers.ChoiceField(choices=("literature", "classical"))
    categoryId = serializers.SlugField(max_length=64, required=False)
    articleId = serializers.SlugField(max_length=64, required=False)
    type = serializers.ChoiceField(choices=("fact", "word", "translation"), required=False)

    def validate(self, values):
        source = values["source"]
        required = "categoryId" if source == "literature" else "articleId"
        excluded = "articleId" if source == "literature" else "categoryId"
        if required not in values or excluded in values:
            raise serializers.ValidationError({required: "必须指定与来源一致的唯一分类／篇目。"})
        if source == "literature" and values.get("type", "fact") != "fact":
            raise serializers.ValidationError({"type": "文学分类只支持 fact。"})
        return values


class StudentContentPagination(PageNumberPagination):
    page_size_query_param = None
    last_page_strings = ()


class StudentContentView(PublicStudentAPIView):
    http_method_names = ("get", "head", "options")

    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        response["Cache-Control"] = "private, no-store"
        patch_vary_headers(response, ("Authorization", "Cookie"))
        return response

    def paginated(self, request, queryset, page_size, serializer):
        paginator = StudentContentPagination()
        paginator.page_size = page_size
        page = paginator.paginate_queryset(queryset, request, view=self)
        return paginator.get_paginated_response(serializer(page))


class LearningConfigView(StudentContentView):
    def get(self, request):
        validate_query_params(request.query_params, EmptyQuery)
        config = LearningConfiguration.current()
        return Response({
            "pageSize": config.page_size,
            "dailyTarget": config.daily_target,
            "examDate": config.exam_date.isoformat() if config.exam_date else None,
        })


class StudentCatalogView(StudentContentView):
    model = None
    revision_field = None
    label_field = None

    def get(self, request):
        validate_query_params(request.query_params, StudentPageQuery)
        anonymous = not (request.user and request.user.is_authenticated)
        cache_key = None
        if anonymous:
            cache_key = "%s:v%s:%s" % (self.__class__.__name__, content_cache.version(), request.query_params.get("page", "1"))
            cached = content_cache.get(cache_key)
            if cached is not None:
                return Response(cached)
        config = LearningConfiguration.current()
        counts = published_questions().filter(**{self.revision_field: OuterRef("pk")}).order_by().values(
            self.revision_field,
        ).annotate(total=Count("pk")).values("total")[:1]
        queryset = self.model.objects.filter(is_active=True).annotate(
            published_count=Coalesce(Subquery(counts, output_field=IntegerField()), Value(0)),
            **self.catalog_annotations(),
        ).annotate(free_count=Least(F("published_count"), Value(config.page_size))).order_by("sort_order", "pk")

        response = self.paginated(request, queryset, config.page_size, lambda page: self.serialize(page, request, config))
        if cache_key:
            content_cache.set(cache_key, response.data)
        return response

    def catalog_annotations(self):
        return {}

    def serialize(self, page, request, config):
        return [{
            "id": item.pk,
            self.label_field: getattr(item, self.label_field),
            "sortOrder": item.sort_order,
            "publishedCount": item.published_count,
            "freeCount": item.free_count,
        } for item in page]


class StudentCategoryListView(StudentCatalogView):
    model = Category
    revision_field = "published_revision__category_id"
    label_field = "name"


class StudentArticleListView(StudentCatalogView):
    model = Article
    revision_field = "published_revision__article_id"
    label_field = "title"

    def catalog_annotations(self):
        def type_count(question_type):
            counts = published_questions().filter(
                published_revision__article_id=OuterRef("pk"), published_revision__type=question_type,
            ).order_by().values("published_revision__article_id").annotate(total=Count("pk")).values("total")[:1]
            return Coalesce(Subquery(counts, output_field=IntegerField()), Value(0))

        return {"published_word_count": type_count("word"), "published_translation_count": type_count("translation")}

    def serialize(self, page, request, config):
        from learning.models import QuestionState

        rows = super().serialize(page, request, config)
        if not rows:
            return rows
        for row, article in zip(rows, page):
            row.update(publishedWordCount=article.published_word_count,
                       publishedTranslationCount=article.published_translation_count)
        readable = accessible_questions(request.user, published_questions().filter(
            published_revision__article_id__in=[row["id"] for row in rows],
            published_revision__type__in=("word", "translation"),
        ), page_size=config.page_size).order_by()
        authenticated = bool(request.user and request.user.is_authenticated)
        if authenticated:
            mastered = QuestionState.objects.filter(user=request.user, question_id=OuterRef("pk"), mastered=True)
            readable = readable.annotate(learned=Exists(mastered))
        counts = {
            row["published_revision__article_id"]: row
            for row in readable.values("published_revision__article_id").annotate(
                words=Count("pk", filter=Q(published_revision__type="word")),
                translations=Count("pk", filter=Q(published_revision__type="translation")),
                **({
                    "mastered": Count("pk", filter=Q(learned=True)),
                    "mastered_words": Count("pk", filter=Q(learned=True, published_revision__type="word")),
                    "mastered_translations": Count("pk", filter=Q(learned=True, published_revision__type="translation")),
                } if authenticated else {}),
            )
        }
        next_by_article = {}
        if authenticated:
            # Return at most one metadata row per article, without reading stems
            # or scanning every question/state through the HTTP client.
            next_rows = readable.annotate(article_position=Window(
                expression=RowNumber(), partition_by=[F("published_revision__article_id")],
                order_by=[F("learned").asc(), F("published_revision__sort_order").asc(), F("pk").asc()],
            )).filter(article_position=1).values("pk", "published_revision__article_id", "published_revision__type")
            next_by_article = {
                row["published_revision__article_id"]: {"id": row["pk"], "type": row["published_revision__type"]}
                for row in next_rows
            }
        for row in rows:
            count = counts.get(row["id"], {})
            row.update(wordCount=count.get("words", 0), translationCount=count.get("translations", 0))
            row["progress"] = {
                "masteredCount": count.get("mastered", 0),
                "masteredWordCount": count.get("mastered_words", 0),
                "masteredTranslationCount": count.get("mastered_translations", 0),
                "nextQuestion": next_by_article.get(row["id"]),
            } if authenticated else None
        return rows


class StudentQuestionListView(StudentContentView):
    def get(self, request):
        query = validate_query_params(request.query_params, StudentQuestionQuery)
        source = query["source"]
        scope_id = query["categoryId"] if source == "literature" else query["articleId"]
        model = Category if source == "literature" else Article
        get_object_or_404(model, pk=scope_id, is_active=True)
        config = LearningConfiguration.current()
        queryset = scope_questions(source, scope_id)
        if "type" in query:
            queryset = queryset.filter(published_revision__type=query["type"])
        total = queryset.count()
        free_ids = list(free_questions(queryset, page_size=config.page_size).values_list("pk", flat=True))
        free_count = len(free_ids)
        activated = has_full_access(request.user)
        readable = queryset if activated else queryset.filter(pk__in=free_ids)
        response = self.paginated(
            request, readable, config.page_size,
            lambda page: self.serialize_questions(request.user, page),
        )
        response.data["access"] = {
            "activated": activated,
            "pageSize": config.page_size,
            "freeCount": free_count,
            "totalCount": total,
            "restrictedCount": max(0, total - response.data["count"]),
        }
        response.data["progress"] = None
        if request.user and request.user.is_authenticated:
            from learning.models import QuestionState

            response.data["progress"] = {"masteredCount": QuestionState.objects.filter(
                user=request.user, mastered=True, question_id__in=Subquery(readable.values("pk")),
            ).count()}
        return response

    @staticmethod
    def serialize_questions(user, page):
        from learning.services import batch_question_states

        return StudentQuestionSerializer(page, many=True, context={
            "question_states": batch_question_states(user, (question.pk for question in page)),
        }).data


class StudentQuestionDetailView(StudentContentView):
    def get(self, request, pk):
        validate_query_params(request.query_params, EmptyQuery)
        config = LearningConfiguration.current()
        readable, activated = question_access(
            request.user, published_questions(), page_size=config.page_size,
        )
        question = readable.filter(pk=pk).first()
        if question is None:
            # Distinguish a published paid question from unpublished/nonexistent
            # without serializing its content into an error response.
            if not published_questions().filter(pk=pk).exists():
                raise Http404
            raise BusinessError("ENTITLEMENT_REQUIRED", "请开通权益后继续学习。", status=403)
        data = dict(StudentQuestionListView.serialize_questions(request.user, [question])[0])
        revision = question.published_revision
        # An index in the user's current typed scope lets clients jump directly
        # to the resume page instead of downloading all preceding pages.
        data["scopeIndex"] = readable.filter(
            published_revision__source=revision.source,
            published_revision__category_id=revision.category_id,
            published_revision__article_id=revision.article_id,
            published_revision__type=revision.type,
        ).filter(
            Q(published_revision__sort_order__lt=revision.sort_order)
            | Q(published_revision__sort_order=revision.sort_order, pk__lt=question.pk)
        ).count()
        data["access"] = {
            "activated": activated,
            "free": free_questions(published_questions().filter(pk=pk), page_size=config.page_size).exists(),
            "pageSize": config.page_size,
        }
        return Response(data)
