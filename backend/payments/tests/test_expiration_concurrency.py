from threading import Barrier
from datetime import timedelta

from django.test import TransactionTestCase, override_settings, skipUnlessDBFeature

from payments.expiration import expire_user_orders
from payments.models import Order
from payments.synchronization import apply_callback
from entitlements.models import EntitlementSource, OpeningReservation
from .sync_fixtures import goods
from . import test_sync_concurrency as synchronization_tests
from .test_preparation import PAYMENT_SETTINGS


@override_settings(**PAYMENT_SETTINGS)
@skipUnlessDBFeature("has_select_for_update")
class OrderExpirationConcurrencyTests(TransactionTestCase):
    setUp = synchronization_tests.PaymentSynchronizationConcurrencyTests.setUp
    pair = synchronization_tests.PaymentSynchronizationConcurrencyTests.pair

    def test_expiry_and_paid_callback_share_account_lock(self):
        barrier = Barrier(2)
        now = self.order.created_at + timedelta(seconds=120)

        def expire():
            barrier.wait(timeout=5)
            return expire_user_orders(self.session.user.pk, now=now)

        def paid():
            barrier.wait(timeout=5)
            return apply_callback(goods(self.order), self.order.app_id)

        self.pair([expire, paid])
        self.assertEqual(Order.objects.get(pk=self.order.pk).status, "fulfilled")
        self.assertEqual(EntitlementSource.objects.count(), 1)
        self.assertFalse(OpeningReservation.objects.get().is_active)

    def test_two_expiry_workers_only_cancel_once(self):
        barrier = Barrier(2)
        now = self.order.created_at + timedelta(seconds=120)

        def expire():
            barrier.wait(timeout=5)
            return expire_user_orders(self.session.user.pk, now=now)

        self.assertEqual(sum(self.pair([expire, expire])), 1)
        self.assertEqual(Order.objects.get(pk=self.order.pk).status, "expired")
        self.assertFalse(OpeningReservation.objects.get().is_active)
