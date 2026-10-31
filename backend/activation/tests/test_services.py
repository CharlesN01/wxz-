from django.contrib.auth import get_user_model
from django.contrib.auth.models import Permission
from django.core.exceptions import ValidationError
from django.test import TestCase
from unittest.mock import patch

from activation.models import ActivationBatch, ActivationCode, ActivationRedemption
from activation.services import batch_fingerprint, code_digest, disable_code, generate_batch, redeem_code, transition_batch
from common.errors import BusinessError
from common.models import IdempotencyRecord
from entitlements.models import AuditEvent, EntitlementSource
from entitlements.services import grant_entitlement, reserve_opening, revoke_entitlement
from distribution.models import AgentProfile


class ActivationServiceTests(TestCase):
    def setUp(self):
        users = get_user_model()
        self.admin = users.objects.create_user(username="activation-manager", is_staff=True)
        self.admin.user_permissions.set(Permission.objects.filter(content_type__app_label__in=("activation", "entitlements")))
        self.user = users.objects.create_user(username="activation-student")
        self.other = users.objects.create_user(username="activation-other")

    def enabled_codes(self, quantity=2, key="generate-key-1"):
        batch, codes = generate_batch(self.admin, quantity, "测试批次", key)
        transition_batch(batch.pk, self.admin, "receive")
        transition_batch(batch.pk, self.admin, "enable")
        return batch, codes

    def assert_error(self, code, operation):
        with self.assertRaises(BusinessError) as error:
            operation()
        self.assertEqual(str(error.exception.detail["error"]["code"]), code)

    def test_generation_is_one_time_and_confirmation_required(self):
        batch, codes = generate_batch(self.admin, 2, "一次领取", "generate-key-1")
        self.assertEqual(len(codes), 2)
        again, repeated = generate_batch(self.admin, 2, "一次领取", "generate-key-1")
        self.assertEqual(again.pk, batch.pk)
        self.assertIsNone(repeated)
        self.assert_error("CODE_UNAVAILABLE", lambda: redeem_code(self.user, codes[0], "redeem-key-1"))
        transition_batch(batch.pk, self.admin, "receive")
        transition_batch(batch.pk, self.admin, "enable")
        result = redeem_code(self.user, codes[0], "redeem-key-1")
        self.assertTrue(result["entitlement"]["active"])
        self.assertEqual(ActivationRedemption.objects.count(), 1)

    def test_active_and_reserved_accounts_do_not_consume_new_code(self):
        _, codes = self.enabled_codes()
        grant_entitlement(self.user, "payment", "existing-order")
        self.assert_error("ALREADY_ACTIVATED", lambda: redeem_code(self.user, codes[0], "redeem-key-1"))
        reserve_opening(self.other, "preparing-order")
        self.assert_error("PURCHASE_IN_PROGRESS", lambda: redeem_code(self.other, codes[1], "redeem-key-2"))
        self.assertEqual(ActivationCode.objects.filter(state="unused").count(), 2)
        self.assertEqual(ActivationRedemption.objects.count(), 0)

    def test_unenabled_batch_explains_administrator_action_without_consuming_code(self):
        batch, codes = generate_batch(self.admin, 1, "未启用批次", "not-enabled-batch-1")
        reserve_opening(self.user, "pending-payment")
        for state in ("awaiting_receipt", "received"):
            if state == "received":
                transition_batch(batch.pk, self.admin, "receive")
            with self.subTest(state=state), self.assertRaises(BusinessError) as error:
                redeem_code(self.user, codes[0], "not-enabled-redeem-1")
            self.assertEqual(str(error.exception.detail["error"]["code"]), "CODE_UNAVAILABLE")
            self.assertIn("尚未启用", str(error.exception.detail["error"]["message"]))
        self.assertEqual(ActivationCode.objects.get().state, "unused")
        self.assertFalse(ActivationRedemption.objects.exists())
        self.assertFalse(EntitlementSource.objects.exists())

    def test_success_replay_after_revoke_does_not_restore_or_consume_new_code(self):
        _, codes = self.enabled_codes()
        first = redeem_code(self.user, codes[0], "redeem-key-1")
        redemption = ActivationRedemption.objects.get()
        revoke_entitlement(redemption.source_id, self.admin, "误发")
        replay = redeem_code(self.user, codes[0], "redeem-key-1")
        self.assertEqual(replay["redemptionId"], first["redemptionId"])
        self.assertFalse(replay["entitlement"]["active"])
        self.assertEqual(EntitlementSource.objects.count(), 1)
        self.assertEqual(ActivationCode.objects.filter(state="redeemed").count(), 1)
        self.assert_error("IDEMPOTENCY_CONFLICT", lambda: redeem_code(self.user, codes[1], "redeem-key-1"))
        self.assertTrue(redeem_code(self.user, codes[1], "redeem-key-2")["entitlement"]["active"])

    def test_regular_code_redemption_attributes_only_to_enabled_scene_and_replay_is_unique(self):
        _, codes = self.enabled_codes(4)
        first_agent = AgentProfile(user=self.admin, agent_code="ATTRIB001", display_name="有效代理", created_by=self.admin)
        first_agent.save(_service=True)
        second_user = get_user_model().objects.create_user(username="attribution-agent-two", is_staff=True)
        second_agent = AgentProfile(user=second_user, agent_code="ATTRIB002", display_name="第二代理", created_by=self.admin)
        second_agent.save(_service=True)
        disabled_user = get_user_model().objects.create_user(username="attribution-agent-disabled", is_staff=True)
        disabled_agent = AgentProfile(user=disabled_user, agent_code="ATTRIB003", display_name="停用代理", status="disabled", created_by=self.admin)
        disabled_agent.save(_service=True)

        first = redeem_code(self.user, codes[0], "attributed-redemption-1", scene="a=attrib001")
        replay = redeem_code(self.user, codes[0], "attributed-redemption-1")
        self.assertEqual(replay["redemptionId"], first["redemptionId"])
        self.assertEqual(ActivationRedemption.objects.get(code__mask__startswith="QM-").attributed_agent_id, first_agent.pk)
        self.assertEqual(ActivationRedemption.objects.filter(attributed_agent=first_agent).count(), 1)

        no_scene_user = get_user_model().objects.create_user(username="attribution-no-scene")
        redeem_code(no_scene_user, codes[1], "attributed-redemption-2")
        invalid_scene_user = get_user_model().objects.create_user(username="attribution-invalid-scene")
        redeem_code(invalid_scene_user, codes[2], "attributed-redemption-3", scene="a=NOT-REAL")
        disabled_scene_user = get_user_model().objects.create_user(username="attribution-disabled-scene")
        redeem_code(disabled_scene_user, codes[3], "attributed-redemption-4", scene=disabled_agent.scene)
        self.assertEqual(ActivationRedemption.objects.filter(attributed_agent__isnull=True).count(), 3)

    def test_cross_batch_generation_idempotency_and_failed_delivery_are_permanent(self):
        batch, raw = generate_batch(self.admin, 1, "首次生成", "generate-key-1")
        self.assert_error("IDEMPOTENCY_CONFLICT", lambda: generate_batch(self.admin, 2, "首次生成", "generate-key-1"))
        self.assertEqual(ActivationBatch.objects.count(), 1)
        self.assertEqual(ActivationCode.objects.count(), 1)
        transition_batch(batch.pk, self.admin, "void", reason="领取失败")
        again, redelivery = generate_batch(self.admin, 1, "首次生成", "generate-key-1")
        self.assertEqual(again.pk, batch.pk)
        self.assertIsNone(redelivery)
        replacement, replacement_raw = generate_batch(self.admin, 1, "重新生成", "generate-key-2")
        self.assertNotEqual(replacement.pk, batch.pk)
        self.assertNotEqual(raw, replacement_raw)
        self.assert_error("CODE_UNAVAILABLE", lambda: redeem_code(self.user, raw[0], "redeem-key-1"))

    def test_rollback_after_entitlement_creation_leaves_code_and_history_untouched(self):
        _, raw = self.enabled_codes()
        with patch("activation.services.idempotency.remember", side_effect=RuntimeError("storage unavailable")):
            with self.assertRaises(RuntimeError):
                redeem_code(self.user, raw[0], "redeem-key-1")
        self.assertEqual(EntitlementSource.objects.count(), 0)
        self.assertEqual(ActivationRedemption.objects.count(), 0)
        self.assertEqual(ActivationCode.objects.filter(state="unused").count(), 2)
        self.assertEqual(AuditEvent.objects.filter(kind__in=("granted", "activation_redeemed")).count(), 0)
        self.assertEqual(IdempotencyRecord.objects.filter(operation="activation.redeem").count(), 0)
        self.assertTrue(redeem_code(self.user, raw[0], "redeem-key-1")["entitlement"]["active"])

    def test_generation_rollback_leaves_no_partial_batch_or_raw_record(self):
        with patch("activation.services._new_code", side_effect=RuntimeError("entropy unavailable")):
            with self.assertRaises(RuntimeError):
                generate_batch(self.admin, 3, "失败测试", "generate-key-1")
        self.assertEqual(ActivationBatch.objects.count(), 0)
        self.assertEqual(IdempotencyRecord.objects.count(), 0)
        self.assertEqual(AuditEvent.objects.count(), 0)

    def test_batch_disabled_and_code_disabled_prevent_redemption_without_changing_rights(self):
        batch, raw = self.enabled_codes()
        transition_batch(batch.pk, self.admin, "disable", reason="暂停使用")
        self.assert_error("CODE_UNAVAILABLE", lambda: redeem_code(self.user, raw[0], "redeem-key-1"))
        transition_batch(batch.pk, self.admin, "enable")
        code = ActivationCode.objects.get(digest=code_digest(raw[0]))
        disable_code(code.pk, self.admin, "误发未使用")
        self.assert_error("CODE_UNAVAILABLE", lambda: redeem_code(self.user, raw[0], "redeem-key-1"))
        self.assertTrue(redeem_code(self.user, raw[1], "redeem-key-1")["entitlement"]["active"])
        source = EntitlementSource.objects.get()
        self.assertIsNone(source.expires_at)
        self.assert_error("CODE_ALREADY_USED", lambda: disable_code(ActivationCode.objects.get(state="redeemed").pk, self.admin, "不能复用"))

    def test_permissions_validation_fingerprint_and_history_writes_are_guarded(self):
        self.assert_error("FORBIDDEN", lambda: generate_batch(self.user, 1, "", "generate-key-1"))
        for quantity in (0, 501, True):
            self.assert_error("INVALID_QUANTITY", lambda: generate_batch(self.admin, quantity, "", "generate-key-1"))
        batch, _ = generate_batch(self.admin, 1, "权限测试", "generate-key-1")
        fingerprint = batch_fingerprint(batch)
        transition_batch(batch.pk, self.admin, "receive")
        self.assert_error("VERSION_CONFLICT", lambda: transition_batch(batch.pk, self.admin, "enable", expected_fingerprint=fingerprint))
        self.assert_error("FORBIDDEN", lambda: transition_batch(batch.pk, self.user, "enable"))
        with self.assertRaises(ValidationError):
            batch.state = "enabled"
            batch.save()
        with self.assertRaises(ValidationError):
            ActivationCode.objects.filter(batch=batch).update(state="disabled")
        with self.assertRaises(ValidationError):
            ActivationBatch.objects.filter(pk=batch.pk).delete()
