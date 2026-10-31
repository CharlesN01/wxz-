from unittest.mock import Mock, patch
from django.db.models import Q

from django.contrib.auth import get_user_model
from django.contrib.auth.models import Permission
from django.test import RequestFactory, TestCase
from django.urls import reverse

from distribution.models import AgentProfile
from operations.admin_dashboard import dashboard_callback


class AdminDashboardTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(
            username="dashboard-operator", password="test-password", is_staff=True
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

    def test_dashboard_does_not_query_or_expose_counts_without_permissions(self):
        with (
            patch("content.models.Question.objects.filter") as questions,
            patch("writing.models.WritingContent.objects.filter") as writings,
            patch("feedback.models.Feedback.objects.filter") as feedback,
            patch("payments.models.PaymentTask.objects.filter") as tasks,
            patch("payments.models.Order.objects.filter") as orders,
        ):
            context = dashboard_callback(self.request, {})

        self.assertEqual(context["workbench_cards"], [])
        self.assertEqual(context["workbench_links"], [])
        for query in (questions, writings, feedback, tasks, orders):
            query.assert_not_called()

    def test_dashboard_counts_only_authorized_work_and_uses_direct_filters(self):
        self.grant(
            "content.view_question",
            "content.import_question",
            "writing.view_writingcontent",
            "accounts.view_studentaccount",
            "payments.view_paymenttask",
            "payments.view_order",
            "feedback.process_feedback",
        )
        with (
            patch("content.models.Question.objects.filter", return_value=Mock(count=Mock(return_value=4))) as questions,
            patch("writing.models.WritingContent.objects.filter", return_value=Mock(count=Mock(return_value=2))) as writings,
            patch("feedback.models.Feedback.objects.filter", return_value=Mock(count=Mock(return_value=3))) as feedback,
            patch("payments.models.PaymentTask.objects.filter", return_value=Mock(count=Mock(return_value=1))) as tasks,
            patch("payments.models.Order.objects.filter", return_value=Mock(count=Mock(return_value=5))) as orders,
        ):
            context = dashboard_callback(self.request, {})

        self.assertEqual(
            [(card["title"], card["count"]) for card in context["workbench_cards"]],
            [("待发布题目", 4), ("待发布应用文", 2), ("待处理反馈", 3), ("失败支付任务", 1), ("待领取激活码", 5)],
        )
        self.assertEqual(questions.call_args.kwargs, {"is_published": False})
        self.assertEqual(writings.call_args.kwargs, {"is_published": False})
        self.assertEqual(feedback.call_args.kwargs, {"status": "pending"})
        self.assertEqual(tasks.call_args.kwargs, {"status": "failed"})
        self.assertEqual(orders.call_args.kwargs, {"status": "code_pending", "agent_attribution__isnull": False})
        self.assertTrue(all(card["url"].startswith("/") for card in context["workbench_cards"]))
        self.assertEqual(
            [link["title"] for link in context["workbench_links"]],
            ["导入题库", "管理题目", "管理应用文", "查找学员", "查看订单", "处理反馈"],
        )
        self.assertEqual(context["workbench_links"][0]["url"], reverse("admin:content_question_import"))

    def test_agent_shortcut_requires_bound_agent_profile(self):
        self.grant(
            "distribution.view_agentprofile",
            "distribution.view_agentorderattribution",
            "distribution.view_agentvoucher",
            "distribution.view_agentperformance",
            "distribution.export_agentperformance",
            "activation.view_activationredemption",
        )
        context = dashboard_callback(self.request, {})
        self.assertNotIn("代理激活明细", [link["title"] for link in context["workbench_links"]])

        AgentProfile(
            user=self.user,
            agent_code="AGENT002",
            display_name="测试代理",
            created_by=self.user,
        ).save(_service=True)
        context = dashboard_callback(self.request, {})
        self.assertIn("代理激活明细", [link["title"] for link in context["workbench_links"]])

    def test_agent_dashboard_shows_distinct_paid_and_redeemed_people(self):
        self.grant(
            "distribution.view_agentprofile",
            "distribution.view_agentorderattribution",
            "distribution.view_agentvoucher",
            "distribution.view_agentperformance",
            "distribution.export_agentperformance",
            "activation.view_activationredemption",
        )
        AgentProfile(
            user=self.user,
            agent_code="AGENT003",
            display_name="统计代理",
            created_by=self.user,
        ).save(_service=True)

        paid_people = Mock()
        paid_people.values.return_value.distinct.return_value.count.return_value = 7
        redeemed_people = Mock()
        redeemed_people.values.return_value.distinct.return_value.count.return_value = 4
        with (
            patch("payments.models.Order.objects.filter", return_value=paid_people) as orders,
            patch("activation.models.ActivationRedemption.objects.filter", return_value=redeemed_people) as redemptions,
        ):
            context = dashboard_callback(self.request, {})

        agent_cards = [card for card in context["workbench_cards"] if card["title"] in ("支付人数", "兑换人数")]
        self.assertEqual([(card["title"], card["count"]) for card in agent_cards], [("支付人数", 7), ("兑换人数", 4)])
        self.assertEqual(agent_cards[0]["url"], reverse("admin:distribution_agentorderattribution_changelist"))
        self.assertEqual(agent_cards[1]["url"], reverse("admin:activation_activationredemption_changelist"))
        orders.assert_called_once_with(
            agent_attribution__agent=AgentProfile.objects.get(user=self.user),
            paid_at__isnull=False,
            status__in=("paid", "code_pending", "code_issued", "code_redeemed", "fulfilled"),
        )
        redemptions.assert_called_once()
        self.assertEqual(
            redemptions.call_args.args[0],
            Q(attributed_agent=AgentProfile.objects.get(user=self.user))
            | Q(agent_voucher__order__agent_attribution__agent=AgentProfile.objects.get(user=self.user)),
        )

    def test_admin_index_renders_workbench_for_staff(self):
        self.user.is_superuser = True
        self.user.save(update_fields=("is_superuser",))
        self.client.force_login(self.user)

        response = self.client.get(reverse("admin:index"))

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "工作台")
        self.assertContains(response, "待发布题目")
        self.assertContains(response, "待处理反馈")
        self.assertContains(response, "导入题库")
