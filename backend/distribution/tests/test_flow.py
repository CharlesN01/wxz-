from django.test import TestCase, override_settings

from activation.models import ActivationRedemption
from activation.services import redeem_code
from common.errors import BusinessError
from entitlements.models import EntitlementSource
from payments.models import Order
from payments.services import create_order, prepare_payment
from payments.synchronization import apply_callback

from distribution.models import AgentOrderAttribution, AgentProfile, AgentVoucher
from distribution.services import reveal_order_voucher
from payments.tests.sync_fixtures import goods
from payments.tests.test_preparation import PAYMENT_SETTINGS, fixtures


@override_settings(**PAYMENT_SETTINGS, AGENT_DISTRIBUTION_ENABLED=True)
class AgentVoucherFlowTests(TestCase):
    def setUp(self):
        self.token, self.session, self.admin, self.product = fixtures()
        self.agent = AgentProfile(
            user=self.admin,
            agent_code="AGENT001",
            display_name="测试代理",
            contact="test",
            scene="a=AGENT001",
            created_by=self.admin,
        )
        self.agent.save(_service=True)

    def make_order(self):
        order = create_order(self.session.user, self.session, self.product.pk, "android", "agent-order-1", "a=AGENT001")["order"]
        prepare_payment(self.session.user, self.session, order["id"], "agent-prepare-1")
        return Order.objects.get(pk=order["id"])

    def test_paid_agent_order_waits_for_one_time_code_then_redeems(self):
        order = self.make_order()
        self.assertEqual(order.agent_attribution.agent_id, self.agent.pk)
        self.assertNotIn("activationCode", order_payload_for_test(order))

        self.assertEqual(apply_callback(goods(order), order.app_id), "applied")
        order.refresh_from_db()
        self.assertEqual(order.status, "code_pending")
        self.assertFalse(EntitlementSource.objects.filter(source_type="payment").exists())
        self.assertFalse(EntitlementSource.objects.filter(source_type="activation").exists())

        result = reveal_order_voucher(self.session.user, order.pk, "reveal-agent-1")
        self.assertTrue(result["activationCode"].startswith("QM-"))
        self.assertEqual(result["order"]["status"], "code_issued")
        order.refresh_from_db()
        self.assertEqual(order.status, "code_issued")
        self.assertEqual(AgentVoucher.objects.count(), 1)
        self.assertNotIn(result["activationCode"], str(AgentVoucher.objects.values()))

        with self.assertRaises(BusinessError) as error:
            reveal_order_voucher(self.session.user, order.pk, "reveal-agent-2")
        self.assertEqual(error.exception.detail["error"]["code"], "ACTIVATION_CODE_ALREADY_REVEALED")

        redeemed = redeem_code(self.session.user, result["activationCode"], "redeem-agent-1")
        self.assertTrue(redeemed["entitlement"]["active"])
        order.refresh_from_db()
        self.assertEqual(order.status, "code_redeemed")
        voucher = AgentVoucher.objects.get(order=order)
        self.assertEqual(voucher.state, "redeemed")
        self.assertEqual(ActivationRedemption.objects.filter(agent_voucher=voucher).count(), 1)
        self.assertFalse(EntitlementSource.objects.filter(source_type="payment").exists())
        self.assertEqual(EntitlementSource.objects.filter(source_type="activation").count(), 1)

    def test_invalid_scene_does_not_create_order_attribution(self):
        order = create_order(self.session.user, self.session, self.product.pk, "android", "ordinary-order-1", "")["order"]
        self.assertFalse(AgentOrderAttribution.objects.filter(order_id=order["id"]).exists())
        with self.assertRaises(BusinessError) as error:
            create_order(self.session.user, self.session, self.product.pk, "android", "invalid-agent-1", "a=UNKNOWN")
        self.assertEqual(error.exception.detail["error"]["code"], "INVALID_AGENT_SCENE")


def order_payload_for_test(order):
    from payments.services import order_payload
    return order_payload(order)
