import importlib
from datetime import datetime, timezone as dt_timezone
from unittest.mock import patch

from django.apps import apps
from django.db import connection
from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from common.models import IdempotencyRecord
from entitlements.services import grant_entitlement
from learning.models import QuestionState
from learning.services import update_question_state
from .fixtures import build_fixture


@override_settings(ROOT_URLCONF="learning.tests.urls")
class FavoriteDateTests(TestCase):
    before = datetime(2026, 10, 20, 15, 59, tzinfo=dt_timezone.utc)
    after = datetime(2026, 10, 20, 16, 1, tzinfo=dt_timezone.utc)

    def setUp(self):
        build_fixture(self)
        self.client = APIClient()
        self.client.credentials(HTTP_AUTHORIZATION="Bearer " + self.token)

    def write(self, question, *, now, version, **values):
        with patch("django.utils.timezone.now", return_value=now):
            return update_question_state(
                self.student, question.pk, {"baseVersion": version, **values},
                f"favorite-date-{question.pk}-{version}",
            )

    def summary(self, now=None, url="/api/student/v1/me/favorites/"):
        with patch("django.utils.timezone.now", return_value=now or self.after):
            response = self.client.get(url)
        self.assertEqual(response.status_code, 200)
        return response.data

    def test_shanghai_midnight_and_mastery_never_change_favorite_date(self):
        self.write(self.first, now=self.before, version=0, favorite=True)
        self.write(self.first, now=self.after, version=1, mastered=True)
        self.write(self.first, now=self.after, version=2, favorite=True)
        state = QuestionState.objects.get(user=self.student, question=self.first)
        self.assertEqual(state.favorited_at, self.before)
        result = self.summary()
        self.assertEqual((result["count"], result["todayAdded"], result["studyDate"]), (1, 0, "2026-10-21"))
        self.assertEqual(result["results"][0]["favoritedAt"], self.before.isoformat())
        self.assertEqual(self.summary(self.before)["todayAdded"], 1)

    def test_cancel_refavorite_and_idempotency_count_only_current_favorites(self):
        self.write(self.first, now=self.before, version=0, favorite=True)
        self.write(self.first, now=self.after, version=1, favorite=False)
        self.assertIsNone(QuestionState.objects.get(user=self.student, question=self.first).favorited_at)
        self.assertEqual(self.summary()["todayAdded"], 0)
        self.write(self.first, now=self.after, version=2, favorite=True)
        self.write(self.first, now=self.after, version=2, favorite=True)
        self.assertEqual(self.summary()["todayAdded"], 1)
        self.write(self.first, now=self.after, version=3, favorite=False)
        self.assertEqual((self.summary()["count"], self.summary()["todayAdded"]), (0, 0))

    def test_summary_is_all_pages_and_only_the_authenticated_users_records(self):
        grant_entitlement(self.student, "activation", "favorite-pagination-access")
        self.config.page_size = 1
        self.config.save()
        self.write(self.first, now=self.after, version=0, favorite=True)
        self.write(self.second, now=self.after, version=0, favorite=True)
        QuestionState.objects.create(user=self.other_student, question=self.first, favorite=True, favorited_at=self.after)
        first = self.summary()
        second = self.summary(url=first["next"])
        self.assertEqual(len(first["results"]), 1)
        self.assertEqual((first["count"], first["todayAdded"]), (2, 2))
        self.assertEqual((second["count"], second["todayAdded"]), (2, 2))

    def test_backfill_recovers_true_transition_and_keeps_unknown_history_null(self):
        self.write(self.first, now=self.before, version=0, favorite=True)
        self.write(self.first, now=self.after, version=1, mastered=True)
        self.write(self.second, now=self.before, version=0, favorite=True)
        self.write(self.second, now=self.after, version=1, favorite=False)
        self.write(self.second, now=self.after, version=2, favorite=True)
        QuestionState.objects.filter(user=self.student).update(favorited_at=None)
        unknown = QuestionState.objects.create(user=self.other_student, question=self.first, favorite=True, version=2)
        restore = importlib.import_module("learning.migrations.0004_questionstate_favorited_at").restore_favorite_times
        restore(apps, type("Editor", (), {"connection": connection})())
        self.assertEqual(QuestionState.objects.get(user=self.student, question=self.first).favorited_at, self.before)
        self.assertEqual(QuestionState.objects.get(user=self.student, question=self.second).favorited_at, self.after)
        unknown.refresh_from_db()
        self.assertIsNone(unknown.favorited_at)
        self.assertEqual(self.summary()["todayAdded"], 1)

    def test_backfill_does_not_guess_across_a_missing_version(self):
        self.write(self.first, now=self.before, version=0, favorite=True)
        self.write(self.first, now=self.after, version=1, mastered=True)
        QuestionState.objects.filter(user=self.student).update(favorited_at=None)
        IdempotencyRecord.objects.filter(user=self.student, key="favorite-date-first-0").delete()
        restore = importlib.import_module("learning.migrations.0004_questionstate_favorited_at").restore_favorite_times
        restore(apps, type("Editor", (), {"connection": connection})())
        self.assertIsNone(QuestionState.objects.get(user=self.student).favorited_at)
