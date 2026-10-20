from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone as dt_timezone
from threading import Barrier
from unittest.mock import patch
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.db import IntegrityError, transaction
from django.test import TestCase, TransactionTestCase, override_settings, skipUnlessDBFeature
from django.utils import timezone
from rest_framework.test import APIClient

from common.errors import BusinessError
from learning.models import LearningActivity, StudyTimeDaily, StudyTimeHeartbeat, StudyTimeSession
from learning.services import SHANGHAI, record_study_time, statistics
from quality.connections import on_independent_connection
from .fixtures import build_fixture, make_session


@override_settings(ROOT_URLCONF="learning.tests.urls")
class StudyTimeAPITests(TestCase):
    def setUp(self):
        build_fixture(self)
        self.client = APIClient()
        self.client.credentials(HTTP_AUTHORIZATION="Bearer " + self.token)
        self.base = timezone.now().replace(microsecond=0)
        self.session_id = str(uuid4())

    def heartbeat(self, sequence=0, elapsed=0, *, at=None, session_id=None):
        with patch("learning.services.timezone.now", return_value=at or self.base):
            return self.client.post("/api/student/v1/me/study-time/", {
                "sessionId": session_id or self.session_id, "sequence": sequence, "elapsedSeconds": elapsed,
            }, format="json")

    def test_anchor_then_wall_clock_bounded_credit_does_not_create_mastery_activity(self):
        anchor = self.heartbeat()
        self.assertEqual(anchor.status_code, 200)
        self.assertEqual((anchor.data["creditedSeconds"], anchor.data["nextSequence"]), (0, 1))
        response = self.heartbeat(1, 60, at=self.base + timedelta(seconds=12))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["creditedSeconds"], 12)
        self.assertEqual(response.data["todayStudySeconds"], 12)
        self.assertFalse(LearningActivity.objects.exists())
        self.assertEqual(StudyTimeDaily.objects.get(user=self.student).study_seconds, 12)
        self.assertIn("no-store", response["Cache-Control"])
        self.assertIn("Authorization", response["Vary"])

    def test_duplicate_and_historical_replays_return_original_without_advancing_anchor(self):
        anchor = self.heartbeat()
        first = self.heartbeat(1, 20, at=self.base + timedelta(seconds=30))
        second = self.heartbeat(2, 10, at=self.base + timedelta(seconds=40))
        replay = self.heartbeat(1, 20, at=self.base + timedelta(seconds=60))
        self.assertEqual(replay.data, first.data)
        self.assertEqual(self.heartbeat(at=self.base + timedelta(seconds=80)).data, anchor.data)
        self.assertEqual(second.data["todayStudySeconds"], 30)
        self.assertEqual(StudyTimeDaily.objects.get().study_seconds, 30)
        session = StudyTimeSession.objects.get()
        self.assertEqual(session.last_sequence, 2)
        self.assertEqual(session.last_received_at, self.base + timedelta(seconds=40))
        self.assertEqual(StudyTimeHeartbeat.objects.count(), 3)

    def test_conflicting_duplicate_and_noncontiguous_sequences_do_not_mutate(self):
        self.heartbeat()
        first = self.heartbeat(1, 20, at=self.base + timedelta(seconds=30))
        for sequence, elapsed in ((1, 30), (3, 30)):
            response = self.heartbeat(sequence, elapsed, at=self.base + timedelta(seconds=60))
            self.assertEqual(response.status_code, 409)
            self.assertEqual(response.data["error"]["code"], "STUDY_TIME_SEQUENCE_CONFLICT")
            self.assertEqual(response.data["error"]["fields"]["expectedSequence"], 2)
        self.assertEqual(StudyTimeDaily.objects.get().study_seconds, first.data["creditedSeconds"])
        self.assertEqual(StudyTimeHeartbeat.objects.count(), 2)

    def test_first_packet_requires_zero_anchor_and_cannot_claim_prior_time(self):
        for sequence, elapsed in ((0, 1), (1, 0), (2, 60)):
            response = self.heartbeat(sequence, elapsed)
            self.assertEqual(response.status_code, 409)
            self.assertEqual(response.data["error"]["code"], "STUDY_TIME_ANCHOR_REQUIRED")
        self.assertFalse(StudyTimeSession.objects.exists())
        self.assertFalse(StudyTimeDaily.objects.exists())

    def test_strict_heartbeat_validation_rejects_types_bounds_unknown_fields_and_query(self):
        valid = {"sessionId": self.session_id, "sequence": 0, "elapsedSeconds": 0}
        for name, invalid in (
            ("sessionId", "not-a-uuid"), ("sessionId", 123), ("sessionId", uuid4().hex),
            ("sequence", "0"), ("sequence", True), ("sequence", -1), ("sequence", 2 ** 31),
            ("elapsedSeconds", "10"), ("elapsedSeconds", True), ("elapsedSeconds", -1),
            ("elapsedSeconds", 61), ("elapsedSeconds", 1.5), ("userId", self.other_student.pk),
            ("studyDate", "2001-01-01"),
        ):
            with self.subTest(name=name, invalid=invalid):
                response = self.client.post("/api/student/v1/me/study-time/", {**valid, name: invalid}, format="json")
                self.assertEqual(response.status_code, 400)
        self.assertEqual(self.client.post("/api/student/v1/me/study-time/?userId=1", valid, format="json").status_code, 400)
        self.assertFalse(StudyTimeSession.objects.exists())

    def test_session_id_is_account_scoped_and_only_bearer_student_can_write(self):
        self.heartbeat()
        self.heartbeat(1, 30, at=self.base + timedelta(seconds=30))
        self.client.credentials(HTTP_AUTHORIZATION="Bearer " + make_session(self.other_student))
        self.assertEqual(self.heartbeat().status_code, 200)
        self.assertEqual(self.heartbeat(1, 10, at=self.base + timedelta(seconds=20)).data["todayStudySeconds"], 10)
        self.assertEqual(StudyTimeSession.objects.count(), 2)
        self.assertEqual(StudyTimeDaily.objects.get(user=self.student).study_seconds, 30)
        self.client.credentials()
        self.assertEqual(self.heartbeat().status_code, 401)
        self.client.force_login(self.operator)
        self.assertEqual(self.heartbeat().status_code, 401)
        self.client.credentials(HTTP_AUTHORIZATION="Bearer invalid")
        self.assertEqual(self.heartbeat().status_code, 401)

    def test_long_offline_gap_caps_current_report_at_thirty_seconds(self):
        self.heartbeat()
        response = self.heartbeat(1, 60, at=self.base + timedelta(hours=2))
        self.assertEqual(response.data["creditedSeconds"], 30)
        next_response = self.heartbeat(2, 30, at=self.base + timedelta(hours=2, seconds=30))
        self.assertEqual(next_response.data["todayStudySeconds"], 60)

    def test_two_sessions_of_same_account_never_double_count_overlapping_intervals(self):
        second_id = str(uuid4())
        self.heartbeat()
        self.heartbeat(session_id=second_id)
        first = self.heartbeat(1, 30, at=self.base + timedelta(seconds=30))
        second = self.heartbeat(1, 30, at=self.base + timedelta(seconds=30), session_id=second_id)
        third = self.heartbeat(2, 30, at=self.base + timedelta(seconds=40), session_id=second_id)
        self.assertEqual((first.data["creditedSeconds"], second.data["creditedSeconds"], third.data["creditedSeconds"]), (30, 0, 10))
        self.assertEqual(StudyTimeDaily.objects.get().study_seconds, 40)

    def test_backward_server_clock_never_increases_credit_or_moves_anchor_back(self):
        self.heartbeat()
        response = self.heartbeat(1, 30, at=self.base - timedelta(seconds=10))
        self.assertEqual(response.data["creditedSeconds"], 0)
        self.assertEqual(StudyTimeSession.objects.get().last_received_at, self.base)
        response = self.heartbeat(2, 30, at=self.base + timedelta(seconds=10))
        self.assertEqual(response.data["creditedSeconds"], 10)


class StudyTimeStatisticsTests(TestCase):
    def setUp(self):
        build_fixture(self)
        self.now = datetime(2026, 10, 20, 16, 0, 10, tzinfo=dt_timezone.utc)

    def record(self, session_id, sequence, elapsed, at):
        with patch("learning.services.timezone.now", return_value=at):
            return record_study_time(self.student, {"sessionId": session_id, "sequence": sequence, "elapsedSeconds": elapsed})

    def test_cross_midnight_splits_real_seconds_between_shanghai_dates(self):
        session_id = uuid4()
        self.record(session_id, 0, 0, self.now - timedelta(seconds=30))
        response = self.record(session_id, 1, 30, self.now)
        self.assertEqual(response["creditedSeconds"], 30)
        rows = dict(StudyTimeDaily.objects.values_list("study_date", "study_seconds"))
        self.assertEqual({day.isoformat(): value for day, value in rows.items()}, {"2026-10-20": 20, "2026-10-21": 10})
        self.assertEqual(response["todayStudySeconds"], 10)

    def test_fractional_midnight_boundary_does_not_lose_or_invent_seconds(self):
        now = self.now.replace(second=0, microsecond=500000)
        session_id = uuid4()
        self.record(session_id, 0, 0, now - timedelta(seconds=1))
        response = self.record(session_id, 1, 1, now)
        self.assertEqual(response["creditedSeconds"], 1)
        self.assertEqual(sum(StudyTimeDaily.objects.values_list("study_seconds", flat=True)), 1)
        self.assertEqual(StudyTimeDaily.objects.get().study_date.isoformat(), "2026-10-20")

    def test_seven_day_trend_zero_fills_and_previous_period_uses_exact_calendar_window(self):
        today = self.now.astimezone(SHANGHAI).date()
        for offset, seconds in ((0, 120), (2, 60), (6, 15), (7, 30), (13, 40), (14, 1000)):
            StudyTimeDaily.objects.create(user=self.student, study_date=today - timedelta(days=offset), study_seconds=seconds)
        LearningActivity.objects.create(user=self.student, question=self.first, study_date=today)
        LearningActivity.objects.create(user=self.student, question=self.second, study_date=today - timedelta(days=6))
        StudyTimeDaily.objects.create(user=self.other_student, study_date=today, study_seconds=500)
        with patch("learning.services.timezone.now", return_value=self.now):
            result = statistics(self.student)
        self.assertEqual(result["todayStudySeconds"], 120)
        self.assertEqual(result["currentPeriodStudySeconds"], 195)
        self.assertEqual(result["previousPeriodStudySeconds"], 70)
        self.assertEqual(len(result["dailyTrend"]), 7)
        self.assertEqual(result["dailyTrend"][0], {"date": (today - timedelta(days=6)).isoformat(), "questionCount": 1, "studySeconds": 15, "isToday": False})
        self.assertEqual(result["dailyTrend"][-1], {"date": today.isoformat(), "questionCount": 1, "studySeconds": 120, "isToday": True})
        self.assertEqual(result["dailyTrend"][1]["studySeconds"], 0)
        self.assertEqual(result["todayQuestions"], 1)
        self.assertEqual(result["masteredQuestions"], 0)

    def test_historical_mastery_never_fabricates_duration_and_empty_trend_is_zero(self):
        today = self.now.astimezone(SHANGHAI).date()
        LearningActivity.objects.create(user=self.student, question=self.first, study_date=today)
        with patch("learning.services.timezone.now", return_value=self.now):
            result = statistics(self.student)
            other = statistics(self.other_student)
        self.assertEqual(result["todayQuestions"], 1)
        self.assertEqual(result["todayStudySeconds"], 0)
        self.assertEqual(result["currentPeriodStudySeconds"], 0)
        self.assertEqual(result["consecutiveStudyDays"], 1)
        self.assertEqual(other["consecutiveStudyDays"], 0)
        self.assertTrue(all(day["questionCount"] == day["studySeconds"] == 0 for day in other["dailyTrend"]))

    def test_streak_joins_real_time_and_mastery_days_but_ignores_future_rows(self):
        today = self.now.astimezone(SHANGHAI).date()
        for offset in (1, 2):
            StudyTimeDaily.objects.create(user=self.student, study_date=today - timedelta(days=offset), study_seconds=10)
        LearningActivity.objects.create(user=self.student, question=self.first, study_date=today - timedelta(days=3))
        LearningActivity.objects.create(user=self.student, question=self.second, study_date=today + timedelta(days=1))
        with patch("learning.services.timezone.now", return_value=self.now):
            result = statistics(self.student)
        self.assertEqual(result["consecutiveStudyDays"], 3)
        self.assertEqual(result["studyDays"], 3)
        StudyTimeDaily.objects.create(user=self.student, study_date=today, study_seconds=10)
        with patch("learning.services.timezone.now", return_value=self.now):
            self.assertEqual(statistics(self.student)["consecutiveStudyDays"], 4)

    def test_heartbeat_receipt_failure_rolls_back_time_and_sequence(self):
        session_id = uuid4()
        self.record(session_id, 0, 0, self.now)
        with patch("learning.services.StudyTimeHeartbeat.objects.create", side_effect=RuntimeError("receipt failed")):
            with self.assertRaises(RuntimeError):
                self.record(session_id, 1, 30, self.now + timedelta(seconds=30))
        self.assertFalse(StudyTimeDaily.objects.exists())
        self.assertEqual(StudyTimeSession.objects.get().last_sequence, 0)
        response = self.record(session_id, 1, 30, self.now + timedelta(seconds=30))
        self.assertEqual(response["creditedSeconds"], 30)

    def test_database_constraints_prevent_duplicate_identity_and_invalid_daily_totals(self):
        session_id = uuid4()
        self.record(session_id, 0, 0, self.now)
        with self.assertRaises(IntegrityError), transaction.atomic():
            StudyTimeSession.objects.create(user=self.student, session_id=session_id, last_received_at=self.now)
        for value in (-1, 86401):
            with self.assertRaises(IntegrityError), transaction.atomic():
                StudyTimeDaily.objects.create(user=self.student, study_date=self.now.date(), study_seconds=value)


@skipUnlessDBFeature("has_select_for_update")
class StudyTimeConcurrencyTests(TransactionTestCase):
    def setUp(self):
        build_fixture(self)
        self.now = timezone.now().replace(microsecond=0)
        self.session_id = uuid4()
        with patch("learning.services.timezone.now", return_value=self.now - timedelta(seconds=30)):
            record_study_time(self.student, {"sessionId": self.session_id, "sequence": 0, "elapsedSeconds": 0})

    def compete(self, payloads):
        barrier = Barrier(2)

        def worker(index):
            user = get_user_model().objects.get(pk=self.student.pk)
            barrier.wait(timeout=5)
            try:
                return record_study_time(user, payloads[index])
            except BusinessError as error:
                return str(error.detail["error"]["code"])

        with patch("learning.services.timezone.now", return_value=self.now), ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(on_independent_connection, lambda index=index: worker(index)) for index in (0, 1)]
            return [future.result(timeout=20) for future in futures]

    def test_same_heartbeat_race_credits_once_and_returns_identical_receipt(self):
        payload = {"sessionId": self.session_id, "sequence": 1, "elapsedSeconds": 30}
        results = self.compete([payload, payload])
        self.assertEqual(results[0], results[1])
        self.assertEqual(StudyTimeDaily.objects.get().study_seconds, 30)
        self.assertEqual(StudyTimeHeartbeat.objects.count(), 2)

    def test_conflicting_heartbeat_race_only_one_payload_wins(self):
        results = self.compete([{"sessionId": self.session_id, "sequence": 1, "elapsedSeconds": seconds} for seconds in (20, 30)])
        self.assertEqual(results.count("STUDY_TIME_SEQUENCE_CONFLICT"), 1)
        self.assertIn(StudyTimeDaily.objects.get().study_seconds, (20, 30))
        self.assertEqual(StudyTimeHeartbeat.objects.count(), 2)

    def test_two_session_race_serializes_user_and_excludes_overlapping_seconds(self):
        second_id = uuid4()
        with patch("learning.services.timezone.now", return_value=self.now - timedelta(seconds=30)):
            record_study_time(self.student, {"sessionId": second_id, "sequence": 0, "elapsedSeconds": 0})
        results = self.compete([{"sessionId": session_id, "sequence": 1, "elapsedSeconds": 30} for session_id in (self.session_id, second_id)])
        self.assertEqual(sorted(result["creditedSeconds"] for result in results), [0, 30])
        self.assertEqual(StudyTimeDaily.objects.get().study_seconds, 30)
