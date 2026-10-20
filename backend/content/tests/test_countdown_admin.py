from datetime import date, timedelta
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.contrib.auth.models import Permission
from django.test import TestCase
from django.urls import reverse

from content.models import LearningConfiguration


class ExamCountdownAdminTests(TestCase):
    def setUp(self):
        self.operator = get_user_model().objects.create_user("countdown-operator", is_staff=True)
        self.operator.user_permissions.add(*Permission.objects.filter(
            content_type__app_label="content", codename__in=("view_learningconfiguration", "change_learningconfiguration")
        ))
        self.viewer = get_user_model().objects.create_user("countdown-viewer", is_staff=True)
        self.viewer.user_permissions.add(Permission.objects.get(
            content_type__app_label="content", codename="view_learningconfiguration"
        ))
        self.config = LearningConfiguration.objects.create()
        self.url = reverse("admin:content_learningconfiguration_change", args=(self.config.pk,))

    def test_countdown_settings_are_labeled_and_leave_date_unset_until_saved(self):
        self.client.force_login(self.operator)
        response = self.client.get(self.url)
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "考试倒计时")
        self.assertContains(response, "留空时不显示倒计时")
        self.assertContains(response, "选择官方考试日期")
        self.assertContains(response, "尚未设置考试日期")
        self.config.refresh_from_db()
        self.assertIsNone(self.config.exam_date)

    def test_save_updates_existing_config_and_public_config_without_new_models(self):
        self.client.force_login(self.operator)
        response = self.client.post(self.url, {"exam_date": "2027-03-21", "page_size": 20, "daily_target": 20})
        self.assertEqual(response.status_code, 302)
        self.config.refresh_from_db()
        self.assertEqual(self.config.exam_date, date(2027, 3, 21))
        self.assertEqual(LearningConfiguration.objects.count(), 1)
        public = self.client.get("/api/student/v1/config/")
        self.assertEqual(public.status_code, 200)
        self.assertEqual(public.json()["examDate"], "2027-03-21")

    def test_readonly_user_cannot_set_exam_date(self):
        self.client.force_login(self.viewer)
        self.assertEqual(self.client.get(self.url).status_code, 200)
        result = self.client.post(self.url, {"exam_date": "2027-03-21", "page_size": 20, "daily_target": 20})
        self.assertEqual(result.status_code, 403)
        self.config.refresh_from_db()
        self.assertIsNone(self.config.exam_date)

    def test_preview_handles_future_today_and_past_without_negative_countdown(self):
        from content.admin import LearningConfigurationAdmin
        from django.contrib import admin

        model_admin = LearningConfigurationAdmin(LearningConfiguration, admin.site)
        today = date(2026, 10, 20)
        with patch("content.admin.timezone.localdate", return_value=today):
            for offset, expected in ((1, "距考试还有 1 天"), (0, "今天考试"), (-1, "考试日期已过")):
                self.config.exam_date = today + timedelta(days=offset)
                self.assertIn(expected, model_admin.countdown_status(self.config))
