from django.contrib.auth import get_user_model
from django.contrib.auth.models import Permission
from django.test import RequestFactory, TestCase
from django.urls import reverse

from config.admin_navigation import navigation
from distribution.models import AgentProfile


class AdminNavigationTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(
            username="sidebar-operator", password="test-password", is_staff=True
        )
        self.request = RequestFactory().get("/admin/")
        self.request.user = self.user

    def grant(self, *permissions):
        rows = []
        for permission in permissions:
            app, codename = permission.split(".")
            rows.append(Permission.objects.get(
                content_type__app_label=app,
                codename=codename,
            ))
        self.user.user_permissions.add(*rows)
        self.user = get_user_model().objects.get(pk=self.user.pk)
        self.request.user = self.user

    def test_navigation_only_shows_permitted_items_in_chinese_collapsible_groups(self):
        self.grant("content.view_question")

        groups = navigation(self.request)

        self.assertEqual([group["title"] for group in groups], ["工作台", "内容管理"])
        self.assertTrue(all(group["collapsible"] for group in groups))
        content_items = groups[1]["items"]
        self.assertEqual(
            [(item["title"], str(item["link"])) for item in content_items],
            [("题目管理", reverse("admin:content_question_changelist"))],
        )

    def test_agent_menu_requires_full_read_role_and_bound_profile(self):
        self.grant(
            "distribution.view_agentprofile",
            "distribution.view_agentorderattribution",
            "distribution.view_agentvoucher",
            "distribution.view_agentperformance",
            "distribution.export_agentperformance",
            "activation.view_activationredemption",
        )
        groups = navigation(self.request)
        self.assertNotIn("激活码与代理", [group["title"] for group in groups])

        AgentProfile(
            user=self.user,
            agent_code="AGENT001",
            display_name="测试代理",
            created_by=self.user,
        ).save(_service=True)
        groups = navigation(self.request)
        agent_group = next(group for group in groups if group["title"] == "激活码与代理")
        self.assertEqual(
            [item["title"] for item in agent_group["items"]],
            ["兑换历史", "代理资料", "代理订单激活码", "代理激活明细导出"],
        )
        self.assertEqual(
            str(agent_group["items"][-1]["link"]),
            reverse("admin:activation_redemption_export_agent"),
        )

    def test_agent_model_links_require_every_read_permission(self):
        self.grant("distribution.view_agentprofile")
        groups = navigation(self.request)
        agent_groups = [group for group in groups if group["title"] == "激活码与代理"]
        self.assertEqual(len(agent_groups), 1)
        self.assertEqual([item["title"] for item in agent_groups[0]["items"]], ["代理资料"])

    def test_full_navigation_has_six_daily_groups_and_collapsed_advanced_records(self):
        self.user.is_superuser = True
        self.user.save(update_fields=("is_superuser",))

        groups = navigation(self.request)

        self.assertEqual(
            [group["title"] for group in groups],
            ["工作台", "内容管理", "学员服务", "商品与交易", "激活码与代理", "运营与系统", "高级记录"],
        )
        self.assertTrue(all(group["collapsible"] for group in groups))
        advanced = groups[-1]
        self.assertIn("题目修订记录", [item["title"] for item in advanced["items"]])
        self.assertIn("支付通知记录", [item["title"] for item in advanced["items"]])
        self.assertEqual(
            sum(item["title"] == "代理激活明细导出" for group in groups for item in group["items"]),
            1,
        )

    def test_empty_change_list_uses_chinese_empty_state(self):
        self.user.is_superuser = True
        self.user.save(update_fields=("is_superuser",))
        self.client.force_login(self.user)

        response = self.client.get(reverse("admin:learning_questionstate_changelist"))

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "暂无符合条件的记录")
        self.assertContains(response, "重置筛选条件")
        self.assertContains(response, "搜索管理功能")
        self.assertContains(response, "输入关键词搜索")
        self.assertNotContains(response, "No results found")

    def test_admin_login_without_next_returns_to_dashboard(self):
        response = self.client.post(reverse("admin:login"), {
            "username": self.user.username,
            "password": "test-password",
        })

        self.assertRedirects(response, reverse("admin:index"))
