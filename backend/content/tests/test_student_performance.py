"""Protect page/group loading from per-question state and catalog query storms."""

from django.contrib.auth import get_user_model
from django.db import connection
from django.test import override_settings
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from content.models import Article, LearningConfiguration, Question
from content.tests.test_student_access import StudentContentFixture
from entitlements.services import grant_entitlement, revoke_entitlement
from learning.models import QuestionState
from learning.services import batch_question_states


@override_settings(ROOT_URLCONF="content.tests.student_test_urls")
class StudentLoadingPerformanceTests(StudentContentFixture):
    def setUp(self):
        self.student = get_user_model().objects.create_user(username="page-state-student")
        self.other_student = get_user_model().objects.create_user(username="page-state-other")
        self.client = APIClient()
        self.questions_url = "/api/student/v1/questions/?source=classical&articleId=quanxue"
        self.articles_url = "/api/student/v1/articles/"

    def authenticate(self):
        self.client.force_authenticate(self.student)

    def test_public_state_is_null_and_does_not_create_rows(self):
        QuestionState.objects.create(user=self.other_student, question=self.first, favorite=True, mastered=True, version=9)
        response = self.client.get(self.questions_url)
        self.assertEqual(response.status_code, 200)
        self.assertTrue(all(row["state"] is None for row in response.data["results"]))
        self.assertIsNone(self.client.get(f"/api/student/v1/questions/{self.first.pk}/").data["state"])
        self.assertEqual(QuestionState.objects.count(), 1)

    def test_question_page_reads_only_own_state_in_one_query(self):
        self.authenticate()
        QuestionState.objects.create(user=self.student, question=self.first, favorite=True, version=4)
        QuestionState.objects.create(user=self.other_student, question=self.second, mastered=True, version=9)
        with CaptureQueriesContext(connection) as captured:
            response = self.client.get(self.questions_url)
        self.assertEqual(response.status_code, 200)
        self.assertEqual([row["state"] for row in response.data["results"]], [
            {"questionId": self.first.pk, "favorite": True, "mastered": False, "version": 4},
            {"questionId": self.second.pk, "favorite": False, "mastered": False, "version": 0},
        ])
        state_queries = [row["sql"] for row in captured if '"learning_questionstate"' in row["sql"]]
        self.assertEqual(len(state_queries), 2)
        self.assertEqual(sum("COUNT(" not in query.upper() for query in state_queries), 1)
        self.assertIn("private", response["Cache-Control"])
        self.assertIn("Authorization", response["Vary"])
        self.assertEqual(QuestionState.objects.count(), 2)
        detail = self.client.get(f"/api/student/v1/questions/{self.first.pk}/")
        self.assertEqual(detail.data["state"], response.data["results"][0]["state"])

    def test_batch_state_query_count_is_constant_and_empty_reads_do_not_write(self):
        with self.assertNumQueries(1):
            states = batch_question_states(self.student, [self.first.pk, self.second.pk, self.paid.pk])
        self.assertEqual(len(states), 3)
        self.assertEqual(states[self.paid.pk]["version"], 0)
        with self.assertNumQueries(0):
            self.assertEqual(batch_question_states(self.student, []), {})
            self.assertIsNone(batch_question_states(None, [self.first.pk]))
        self.assertFalse(QuestionState.objects.exists())

    def test_catalog_anonymous_counts_only_readable_published_types(self):
        response = self.client.get(self.articles_url)
        row = next(row for row in response.data["results"] if row["id"] == self.article.pk)
        self.assertEqual((row["wordCount"], row["translationCount"]), (1, 0))
        self.assertEqual((row["publishedWordCount"], row["publishedTranslationCount"]), (1, 1))
        self.assertEqual(row["publishedCount"], 3)
        self.assertIsNone(row["progress"])

    def test_catalog_progress_uses_own_accessible_state_and_safe_next_question(self):
        self.authenticate()
        QuestionState.objects.create(user=self.student, question=self.first, mastered=True, version=1)
        # Another user's mastery must not affect this user's next question.
        QuestionState.objects.create(user=self.other_student, question=self.paid, mastered=True, version=5)
        response = self.client.get(self.articles_url)
        row = next(row for row in response.data["results"] if row["id"] == self.article.pk)
        self.assertEqual(row["progress"], {"masteredCount": 1, "masteredWordCount": 1,
                                           "masteredTranslationCount": 0,
                                           "nextQuestion": {"id": self.first.pk, "type": "word"}})
        source = grant_entitlement(self.student, "activation", "loading-test-full-access")
        response = self.client.get(self.articles_url)
        row = next(row for row in response.data["results"] if row["id"] == self.article.pk)
        self.assertEqual((row["wordCount"], row["translationCount"]), (1, 1))
        self.assertEqual(row["progress"], {"masteredCount": 1, "masteredWordCount": 1,
                                           "masteredTranslationCount": 0,
                                           "nextQuestion": {"id": self.paid.pk, "type": "translation"}})
        operator = get_user_model().objects.create_superuser(username="loading-test-operator")
        revoke_entitlement(source.pk, operator, "检查撤权后的目录访问范围")
        row = next(row for row in self.client.get(self.articles_url).data["results"] if row["id"] == self.article.pk)
        self.assertEqual(row["translationCount"], 0)
        self.assertEqual(row["progress"]["nextQuestion"]["id"], self.first.pk)

    def test_catalog_queries_stay_bounded_when_articles_and_questions_increase(self):
        self.authenticate()
        config = LearningConfiguration.current()
        config.page_size = 100
        config.save()
        with CaptureQueriesContext(connection) as before:
            response = self.client.get(self.articles_url)
        self.assertEqual(response.status_code, 200)
        for index in range(8):
            article = Article.objects.create(id=f"performance-{index}", title=f"篇目{index}")
            for question_index in range(4):
                self.make_question(f"performance-{index}-{question_index}", article=article, order=question_index)
        with CaptureQueriesContext(connection) as after:
            response = self.client.get(self.articles_url)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(after), len(before))
        self.assertLessEqual(len(after), 7)
        self.assertEqual(len(response.data["results"]), 10)

    def test_empty_and_withdrawn_articles_have_no_progress_target(self):
        self.authenticate()
        Article.objects.create(id="empty", title="空篇目", sort_order=0)
        Question.objects.filter(published_revision__article=self.article).update(is_published=False)
        rows = self.client.get(self.articles_url).data["results"]
        for row in rows:
            self.assertEqual((row["wordCount"], row["translationCount"]), (0, 0))
            self.assertEqual(row["progress"], {"masteredCount": 0, "masteredWordCount": 0,
                                               "masteredTranslationCount": 0, "nextQuestion": None})

    def test_question_progress_counts_whole_readable_scope_not_only_current_page(self):
        self.assertIsNone(self.client.get(self.questions_url).data["progress"])
        self.authenticate()
        grant_entitlement(self.student, "activation", "progress-whole-scope")
        for question in (self.first, self.second, self.paid):
            QuestionState.objects.create(user=self.student, question=question, mastered=True, version=1)
        QuestionState.objects.create(user=self.other_student, question=self.other, mastered=True, version=4)
        for page in (1, 2):
            response = self.client.get(self.questions_url + f"&page={page}")
            self.assertEqual(response.data["progress"], {"masteredCount": 3})
        response = self.client.get(self.questions_url + "&type=translation")
        self.assertEqual(response.data["progress"], {"masteredCount": 1})
        article = next(row for row in self.client.get(self.articles_url).data["results"] if row["id"] == self.article.pk)
        self.assertEqual(article["progress"]["masteredWordCount"], 1)
        self.assertEqual(article["progress"]["masteredTranslationCount"], 1)

    def test_question_progress_excludes_now_inaccessible_states(self):
        self.authenticate()
        QuestionState.objects.create(user=self.student, question=self.paid, mastered=True, version=1)
        response = self.client.get(self.questions_url)
        self.assertEqual(response.data["progress"], {"masteredCount": 0})

    def test_scope_progress_does_not_add_queries_when_unloaded_questions_increase(self):
        self.authenticate()
        grant_entitlement(self.student, "activation", "progress-bounded-queries")
        with CaptureQueriesContext(connection) as before:
            initial = self.client.get(self.questions_url)
        self.assertEqual(initial.status_code, 200)
        self.assertEqual(initial.data["progress"], {"masteredCount": 0})
        for index in range(24):
            question = self.make_question(f"progress-extra-{index:02d}", order=10 + index)
            QuestionState.objects.create(user=self.student, question=question, mastered=True, version=1)
        # Drafts, other articles, and another user's states cannot inflate the
        # aggregate, even though none of these records appears on the first page.
        QuestionState.objects.create(user=self.student, question=self.draft, mastered=True, version=1)
        QuestionState.objects.create(user=self.student, question=self.other, mastered=True, version=1)
        QuestionState.objects.create(user=self.other_student, question=self.first, mastered=True, version=1)
        with CaptureQueriesContext(connection) as after:
            response = self.client.get(self.questions_url)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["count"], 27)
        self.assertEqual(response.data["progress"], {"masteredCount": 24})
        self.assertEqual([row["id"] for row in response.data["results"]], [self.first.pk, self.second.pk])
        self.assertEqual(len(after), len(before))
        state_queries = [row["sql"] for row in after if '"learning_questionstate"' in row["sql"]]
        self.assertEqual(len(state_queries), 2)
        self.assertEqual(sum("COUNT(" not in query.upper() for query in state_queries), 1)

    def test_article_typed_progress_drops_withdrawn_and_restricted_mastery(self):
        self.authenticate()
        source = grant_entitlement(self.student, "activation", "article-progress-revoke")
        for question in (self.first, self.paid, self.draft):
            QuestionState.objects.create(user=self.student, question=question, mastered=True, version=1)
        QuestionState.objects.create(user=self.other_student, question=self.other, mastered=True, version=1)
        row = next(row for row in self.client.get(self.articles_url).data["results"] if row["id"] == self.article.pk)
        self.assertEqual((row["progress"]["masteredCount"], row["progress"]["masteredWordCount"],
                          row["progress"]["masteredTranslationCount"]), (2, 1, 1))
        operator = get_user_model().objects.create_superuser(username="article-progress-operator")
        revoke_entitlement(source.pk, operator, "检查目录掌握数只计可读题")
        row = next(row for row in self.client.get(self.articles_url).data["results"] if row["id"] == self.article.pk)
        self.assertEqual((row["progress"]["masteredCount"], row["progress"]["masteredWordCount"],
                          row["progress"]["masteredTranslationCount"]), (1, 1, 0))
        Question.objects.filter(pk=self.first.pk).update(is_published=False)
        row = next(row for row in self.client.get(self.articles_url).data["results"] if row["id"] == self.article.pk)
        # Publication changes also move the free window; the translation is
        # now readable and its existing mastery counts again.
        self.assertEqual((row["progress"]["masteredCount"], row["progress"]["masteredWordCount"],
                          row["progress"]["masteredTranslationCount"]), (1, 0, 1))
        Question.objects.filter(pk=self.paid.pk).update(is_published=False)
        row = next(row for row in self.client.get(self.articles_url).data["results"] if row["id"] == self.article.pk)
        self.assertEqual(row["progress"], {"masteredCount": 0, "masteredWordCount": 0,
                                           "masteredTranslationCount": 0, "nextQuestion": None})

    def test_detail_scope_index_is_typed_scoped_and_stable_at_tied_sort_order(self):
        self.authenticate()
        grant_entitlement(self.student, "activation", "scope-index-full")
        tied = self.make_question("00-tied-word", order=1)
        later = self.make_question("scope-later-word", order=7)
        self.make_question("scope-other-word", article=self.other_article, order=0)
        for question, expected in ((tied, 0), (self.first, 1), (later, 2), (self.paid, 0)):
            with self.subTest(question=question.pk):
                response = self.client.get(f"/api/student/v1/questions/{question.pk}/")
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.data["scopeIndex"], expected)
        # Page responses do not calculate or carry detail-only indexes.
        response = self.client.get(self.questions_url)
        self.assertTrue(all("scopeIndex" not in row for row in response.data["results"]))

    def test_detail_scope_index_uses_current_access_after_grant_and_revocation(self):
        paid_word = self.make_question("scope-paid-word", order=4)
        free = self.client.get(f"/api/student/v1/questions/{self.first.pk}/")
        self.assertEqual(free.data["scopeIndex"], 0)
        self.assertEqual(self.client.get(f"/api/student/v1/questions/{paid_word.pk}/").status_code, 403)
        self.authenticate()
        source = grant_entitlement(self.student, "activation", "scope-index-revoke")
        self.assertEqual(self.client.get(f"/api/student/v1/questions/{paid_word.pk}/").data["scopeIndex"], 1)
        operator = get_user_model().objects.create_superuser(username="scope-index-operator")
        revoke_entitlement(source.pk, operator, "检查续学定位撤权")
        self.assertEqual(self.client.get(f"/api/student/v1/questions/{paid_word.pk}/").status_code, 403)
        self.assertEqual(self.client.get(f"/api/student/v1/questions/{self.first.pk}/").data["scopeIndex"], 0)
