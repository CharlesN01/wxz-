from django.contrib.auth import get_user_model
from django.contrib.auth.models import Permission
from django.test import RequestFactory, TestCase
from django.urls import reverse

from config.admin_navigation import navigation


class AdminNavigationTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(
            username="sidebar-operator", password="test-password", is_staff=True
        )
        self.request = RequestFactory().get("/admin/")
        self.request.user = self.user

    def test_navigation_only_shows_permitted_items_in_collapsible_chinese_groups(self):
        question_permission = Permission.objects.get(
            content_type__app_label="content",
            content_type__model="question",
            codename="view_question",
        )
        self.user.user_permissions.add(question_permission)

        groups = navigation(self.request)

        self.assertEqual(len(groups), 1)
        self.assertEqual(groups[0]["title"], "题库内容")
        self.assertTrue(groups[0]["collapsible"])
        self.assertEqual(
            [(item["title"], str(item["link"])) for item in groups[0]["items"]],
            [("题目管理", reverse("admin:content_question_changelist"))],
        )

    def test_agent_export_link_requires_export_permission(self):
        redemption_permission = Permission.objects.get(
            content_type__app_label="activation",
            content_type__model="activationredemption",
            codename="view_activationredemption",
        )
        export_permission = Permission.objects.get(
            content_type__app_label="distribution",
            content_type__model="agentvoucher",
            codename="export_agentperformance",
        )
        self.user.user_permissions.add(redemption_permission)
        groups = navigation(self.request)
        self.assertEqual([group["title"] for group in groups], ["激活码"])

        self.user.user_permissions.add(export_permission)
        self.user = get_user_model().objects.get(pk=self.user.pk)
        self.request.user = self.user
        groups = navigation(self.request)
        agent_group = next(group for group in groups if group["title"] == "代理分销")
        self.assertEqual(
            str(agent_group["items"][0]["link"]),
            reverse("admin:activation_redemption_export_agent"),
        )

    def test_empty_change_list_uses_chinese_empty_state(self):
        self.user.is_superuser = True
        self.user.save(update_fields=("is_superuser",))
        self.client.force_login(self.user)

        response = self.client.get(reverse("admin:learning_questionstate_changelist"))

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "暂无数据")
        self.assertContains(response, "清除筛选条件")
        self.assertNotContains(response, "No results found")
