import csv
from io import StringIO

from django.contrib.auth import get_user_model
from django.contrib.auth.models import Group, Permission
from django.contrib.admin.sites import site
from django.core.exceptions import PermissionDenied
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import RequestFactory
from django.core.management import call_command
from django.test import TestCase, override_settings
from django.urls import reverse
from django.utils import timezone

from activation.models import ActivationBatch, ActivationCode, ActivationRedemption
from accounts.models import WeChatIdentity
from distribution.models import AgentOrderAttribution, AgentProfile, AgentVoucher
from distribution.admin import AgentProfileAdmin
from entitlements.services import grant_entitlement
from payments.models import Order
from payments.tests.test_preparation import PAYMENT_SETTINGS, fixtures


@override_settings(**PAYMENT_SETTINGS)
class AgentAdminScopeTests(TestCase):
    def setUp(self):
        _, session, _, self.product = fixtures()
        self.student = session.user
        self.agent_a = self.make_staff("agent-admin-a")
        self.agent_b = self.make_staff("agent-admin-b")
        self.creator = self.make_staff("agent-admin-creator")
        self.profile_a = self.make_agent(self.agent_a, "AGENT_A", "代理甲")
        self.profile_b = self.make_agent(self.agent_b, "AGENT_B", "代理乙")
        self.redemption_a = self.make_agent_redemption(self.profile_a, "A1B2", self.student)
        self.redemption_b = self.make_agent_redemption(self.profile_b, "C3D4", self.student)
        self.normal_redemption = self.make_normal_redemption()

        call_command("setup_business_roles", verbosity=0)
        self.agent_group = Group.objects.get(name="代理本人")
        self.agent_a.groups.add(self.agent_group)
        self.agent_b.groups.add(self.agent_group)
        self.manager_group = Group.objects.get(name="代理业绩")
        self.internal_viewer = self.make_staff("agent-admin-internal")
        self.internal_viewer.groups.add(self.manager_group)

    @staticmethod
    def make_staff(username):
        return get_user_model().objects.create_user(username=username, password="test-password", is_staff=True)

    def make_agent(self, user, code, name):
        agent = AgentProfile(
            user=user,
            agent_code=code,
            display_name=name,
            created_by=self.creator,
        )
        agent.save(_service=True)
        return agent

    def make_agent_redemption(self, agent, suffix, redeemer):
        identity, _ = WeChatIdentity.objects.get_or_create(
            user=redeemer,
            app_id="wx-payment-test",
            openid="student-openid",
            defaults={"encrypted_session_key": "encrypted-test-value"},
        )
        order = Order(
            user=redeemer,
            identity=identity,
            product=self.product,
            product_name=self.product.name,
            price_fen=1000,
            platform_product_id="permanent-bank",
            app_id="wx-payment-test",
            environment=0,
            channel="android",
            status="code_redeemed",
        )
        order.save(_service=True)
        attribution = AgentOrderAttribution(order=order, agent=agent, scene=agent.scene)
        attribution.save(_service=True)
        voucher = AgentVoucher(
            order=order,
            digest=(suffix.lower() * 32)[:64],
            mask=f"QM-{suffix}-TEST",
            state="redeemed",
            redeemed_by=redeemer,
            redeemed_at=timezone.now(),
        )
        voucher.save(_service=True)
        source = grant_entitlement(redeemer, "activation", str(voucher.pk))
        redemption = ActivationRedemption(agent_voucher=voucher, user=redeemer, source=source)
        redemption.save(_service=True)
        return redemption

    def make_normal_redemption(self):
        batch = ActivationBatch(quantity=1, created_by=self.creator)
        batch.save(_service=True)
        code = ActivationCode(
            batch=batch,
            digest="e" * 64,
            mask="QM-NORMAL-TEST",
            state="redeemed",
            redeemed_by=self.student,
            redeemed_at=timezone.now(),
        )
        code.save(_service=True)
        source = grant_entitlement(self.student, "activation", str(code.pk))
        redemption = ActivationRedemption(code=code, user=self.student, source=source)
        redemption.save(_service=True)
        return redemption

    def test_agent_role_is_read_only_and_has_no_management_or_reschedule_permissions(self):
        expected = {
            ("distribution", "view_agentprofile"),
            ("distribution", "view_agentorderattribution"),
            ("distribution", "view_agentvoucher"),
            ("distribution", "view_agentperformance"),
            ("distribution", "export_agentperformance"),
            ("activation", "view_activationredemption"),
        }
        actual = set(self.agent_group.permissions.values_list(
            "content_type__app_label", "codename"
        ))
        self.assertEqual(actual, expected)
        self.assertFalse(self.agent_a.has_perm("distribution.manage_agentprofile"))
        self.assertFalse(self.agent_a.has_perm("distribution.qrcode_agentprofile"))
        self.assertFalse(self.agent_a.has_perm("distribution.upload_agentwechatqr_agentprofile"))
        self.assertFalse(self.agent_a.has_perm("payments.reschedule_paymenttask"))

    def test_lists_details_filters_and_qr_action_are_scoped_to_bound_agent(self):
        self.client.force_login(self.agent_a)
        urls_and_markers = (
            ("admin:distribution_agentprofile_changelist", "代理甲", "代理乙"),
            ("admin:distribution_agentorderattribution_changelist", self.profile_a.agent_code, self.profile_b.agent_code),
            ("admin:distribution_agentvoucher_changelist", "QM-A1B2-TEST", "QM-C3D4-TEST"),
            ("admin:activation_activationredemption_changelist", "QM-A1B2-TEST", "QM-C3D4-TEST"),
        )
        for route, visible, hidden in urls_and_markers:
            with self.subTest(route=route):
                response = self.client.get(reverse(route))
                self.assertEqual(response.status_code, 200)
                self.assertContains(response, visible)
                self.assertNotContains(response, hidden)

        filtered = self.client.get(
            reverse("admin:distribution_agentorderattribution_changelist"),
            {"agent__id__exact": str(self.profile_b.pk)},
        )
        self.assertEqual(filtered.status_code, 200)
        self.assertNotContains(filtered, self.profile_b.agent_code)
        for route in (
            "admin:distribution_agentvoucher_changelist",
            "admin:activation_activationredemption_changelist",
        ):
            response = self.client.get(reverse(route), {"q": "QM-C3D4-TEST"})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(list(response.context["cl"].result_list), [])

        self.assertNotContains(
            self.client.get(reverse("admin:activation_activationredemption_changelist")),
            "QM-NORMAL-TEST",
        )
        self.assertEqual(
            self.client.get(reverse("admin:distribution_agentprofile_change", args=(self.profile_a.pk,))).status_code,
            200,
        )
        cross_profile = self.client.get(
            reverse("admin:distribution_agentprofile_change", args=(self.profile_b.pk,)),
            follow=True,
        )
        self.assertEqual(cross_profile.status_code, 200)
        self.assertNotContains(cross_profile, "代理乙")
        for route, object_id in (
            ("admin:distribution_agentorderattribution_change", self.redemption_b.agent_voucher.order.agent_attribution.pk),
            ("admin:distribution_agentvoucher_change", self.redemption_b.agent_voucher.pk),
            ("admin:activation_activationredemption_change", self.redemption_b.pk),
        ):
            with self.subTest(detail=route):
                response = self.client.get(reverse(route, args=(object_id,)), follow=True)
                self.assertEqual(response.status_code, 200)
                self.assertNotContains(response, "QM-C3D4-TEST")
        self.assertEqual(
            self.client.get(reverse("admin:distribution_agent_generate_qr", args=(self.profile_b.pk,))).status_code,
            403,
        )
        self.assertEqual(
            self.client.post(reverse("admin:distribution_agentprofile_change", args=(self.profile_a.pk,)), {"status": "disabled", "_save": "Save"}).status_code,
            403,
        )

    def test_export_ignores_cross_agent_filter_and_excludes_regular_redemptions(self):
        self.client.force_login(self.agent_a)
        response = self.client.get(
            reverse("admin:activation_redemption_export_agent"),
            {"agent": str(self.profile_b.pk)},
        )
        self.assertEqual(response.status_code, 200)
        rows = list(csv.reader(StringIO(response.content.decode("utf-8-sig"))))
        rendered = str(rows)
        self.assertIn("QM-A1B2-TEST", rendered)
        self.assertNotIn("QM-C3D4-TEST", rendered)
        self.assertNotIn("QM-NORMAL-TEST", rendered)

    def test_agent_scope_and_export_include_regular_code_redemptions_attributed_by_scene(self):
        other_student = get_user_model().objects.create_user(username="attributed-code-student")
        batch = ActivationBatch(quantity=1, created_by=self.creator)
        batch.save(_service=True)
        code = ActivationCode(batch=batch, digest="f" * 64, mask="QM-ATTRIBUTED-TEST", state="redeemed", redeemed_by=other_student, redeemed_at=timezone.now())
        code.save(_service=True)
        source = grant_entitlement(other_student, "activation", str(code.pk))
        attributed = ActivationRedemption(code=code, user=other_student, source=source, attributed_agent=self.profile_a)
        attributed.save(_service=True)

        self.client.force_login(self.agent_a)
        response = self.client.get(reverse("admin:activation_activationredemption_changelist"))
        self.assertContains(response, "QM-ATTRIBUTED-TEST")
        self.assertNotContains(response, "QM-NORMAL-TEST")
        self.assertNotContains(response, "QM-C3D4-TEST")
        export = self.client.get(reverse("admin:activation_redemption_export_agent"))
        text = export.content.decode("utf-8-sig")
        self.assertIn("QM-ATTRIBUTED-TEST", text)
        self.assertIn("普通激活码", text)
        self.assertNotIn("QM-C3D4-TEST", text)

        self.client.force_login(self.agent_b)
        scoped = self.client.get(reverse("admin:activation_activationredemption_changelist"))
        self.assertNotContains(scoped, "QM-ATTRIBUTED-TEST")
        self.assertContains(scoped, "QM-C3D4-TEST")

    def test_unbound_agent_role_fails_closed_for_rows_and_export(self):
        unbound = self.make_staff("agent-admin-unbound")
        unbound.groups.add(self.agent_group)
        self.client.force_login(unbound)
        for route in (
            "admin:distribution_agentprofile_changelist",
            "admin:distribution_agentorderattribution_changelist",
            "admin:distribution_agentvoucher_changelist",
            "admin:activation_activationredemption_changelist",
        ):
            with self.subTest(route=route):
                response = self.client.get(reverse(route))
                self.assertEqual(response.status_code, 200)
                self.assertNotContains(response, "代理甲")
                self.assertNotContains(response, "代理乙")
        export = self.client.get(reverse("admin:activation_redemption_export_agent"))
        self.assertEqual(export.status_code, 200)
        self.assertNotIn("QM-A1B2-TEST", export.content.decode())
        self.assertNotIn("QM-C3D4-TEST", export.content.decode())

    def test_internal_performance_role_retains_all_agent_rows(self):
        self.client.force_login(self.internal_viewer)
        for route, marker in (
            ("admin:distribution_agentorderattribution_changelist", self.profile_b.agent_code),
            ("admin:distribution_agentvoucher_changelist", "QM-C3D4-TEST"),
            ("admin:activation_activationredemption_changelist", "QM-C3D4-TEST"),
        ):
            with self.subTest(route=route):
                self.assertContains(self.client.get(reverse(route)), marker)
        response = self.client.get(reverse("admin:activation_redemption_export_agent"))
        self.assertContains(response, "QM-A1B2-TEST")
        self.assertContains(response, "QM-C3D4-TEST")
        self.assertNotContains(response, "QM-NORMAL-TEST")

    def test_agent_management_role_has_separate_wechat_qr_upload_permission(self):
        manager = Group.objects.get(name="代理管理")
        self.assertTrue(manager.permissions.filter(codename="upload_agentwechatqr_agentprofile").exists())
        self.assertFalse(self.agent_group.permissions.filter(codename="upload_agentwechatqr_agentprofile").exists())

    def test_agent_wechat_qr_upload_requires_its_explicit_permission(self):
        editor = self.make_staff("agent-admin-editor")
        editor.user_permissions.add(*Permission.objects.filter(
            content_type__app_label="distribution",
            codename="view_agentprofile",
        ))
        model_admin = AgentProfileAdmin(AgentProfile, site)
        request = RequestFactory().post("/admin/")
        request.user = editor
        self.assertIn("agent_wechat_qr", model_admin.get_readonly_fields(request, self.profile_a))

        request = RequestFactory().post("/admin/", {"agent_wechat_qr": SimpleUploadedFile(
            "agent.png", b"\x89PNG\r\n\x1a\n" + b"\x00" * 20, content_type="image/png",
        )})
        request.user = editor
        with self.assertRaises(PermissionDenied):
            model_admin.save_model(request, self.profile_a, None, True)

        editor.user_permissions.add(Permission.objects.get(
            content_type__app_label="distribution", codename="manage_agentprofile",
        ))
        editor = get_user_model().objects.get(pk=editor.pk)
        request.user = editor
        self.assertNotIn("agent_wechat_qr", model_admin.get_readonly_fields(request, self.profile_a))
