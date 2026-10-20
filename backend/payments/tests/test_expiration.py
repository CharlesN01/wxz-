from datetime import timedelta
from io import StringIO
from unittest.mock import patch

from django.core.management import call_command
from django.test import override_settings
from rest_framework.test import APIClient

from entitlements.models import AuditEvent, EntitlementSource, OpeningReservation
from entitlements.services import check_new_opening
from payments.expiration import expire_due_orders, expire_user_orders
from payments.models import Order, PaymentTask
from payments.services import create_order, prepare_payment
from payments.synchronization import apply_callback, query_payment
from payments.tasks import claim_task, finish_task, run_task
from .sync_fixtures import SyncFixture, goods
from .test_preparation import PAYMENT_SETTINGS


@override_settings(**PAYMENT_SETTINGS)
class OrderExpirationTests(SyncFixture):
    def at(self, seconds):
        return patch("django.utils.timezone.now", return_value=self.order.created_at + timedelta(seconds=seconds))

    def test_exact_two_minute_boundary_closes_without_query_and_releases_once(self):
        with self.at(119), patch("payments.gateway.query_order") as query:
            self.assertEqual(expire_due_orders(), 0)
            self.assertTrue(OpeningReservation.objects.get().is_active)
        with self.at(120), patch("payments.gateway.query_order") as query:
            self.assertEqual(expire_due_orders(), 1)
            self.assertEqual(expire_due_orders(), 0)
            query.assert_not_called()
        self.order.refresh_from_db()
        self.assertEqual(self.order.status, "expired")
        reservation = OpeningReservation.objects.get()
        self.assertFalse(reservation.is_active)
        self.assertEqual(reservation.release_reason, "order_timeout")
        self.assertEqual(PaymentTask.objects.get().status, "done")
        self.assertEqual(AuditEvent.objects.filter(kind="payment_order_expired").count(), 1)
        self.assertFalse(EntitlementSource.objects.exists())

    def test_new_order_immediately_reuses_expired_reservation(self):
        with self.at(120):
            new_id = create_order(self.session.user, self.session, self.product.pk, "android", "after-timeout-order")["order"]["id"]
            prepare_payment(self.session.user, self.session, new_id, "after-timeout-prepare")
        reservation = OpeningReservation.objects.get()
        self.assertTrue(reservation.is_active)
        self.assertEqual(reservation.order_id, new_id)
        self.order.refresh_from_db()
        self.assertEqual(self.order.status, "expired")

    def test_reprepare_and_idempotent_replay_never_extend_deadline(self):
        with self.at(120):
            for key in ("sync-prepare-1", "new-key-after-timeout"):
                result = prepare_payment(self.session.user, self.session, self.order.pk, key)
                self.assertEqual(result["order"]["status"], "expired")
                self.assertIsNone(result["payment"])
            result = create_order(self.session.user, self.session, self.product.pk, "android", "sync-order-1")
            self.assertEqual(result["order"]["id"], self.order.pk)
            self.assertEqual(result["order"]["status"], "expired")
            self.assertEqual(Order.objects.count(), 1)

    def test_read_and_query_expire_without_external_requests(self):
        client = APIClient()
        client.credentials(HTTP_AUTHORIZATION="Bearer " + self.token)
        with self.at(120), patch("payments.gateway.query_order") as query:
            detail = client.get(f"/api/student/v1/orders/{self.order.pk}/")
            self.assertEqual(detail.status_code, 200)
            self.assertEqual(detail.data["statusLabel"], "超时已取消")
            self.assertEqual(detail.data["paymentWindowSeconds"], 120)
            self.assertEqual(detail.data["expiresAt"], self.order.payment_expires_at.isoformat())
            listed = client.get("/api/student/v1/orders/")
            self.assertEqual(listed.data["results"][0]["status"], "expired")
            self.assertEqual(query_payment(self.session.user, self.order.pk, "expired-query-key")["order"]["status"], "expired")
            query.assert_not_called()

    def test_activation_opening_check_expires_reservation_without_waiting_for_worker(self):
        with self.at(120):
            check_new_opening(self.session.user)
        self.assertFalse(OpeningReservation.objects.get().is_active)

    def test_unprepared_order_also_expires_but_paid_orders_do_not(self):
        # A created order has no payment task or purchase reservation of its own.
        order = Order(
            user=self.order.user, identity=self.order.identity, product=self.product, product_name=self.product.name,
            price_fen=self.product.price_fen, platform_product_id=self.product.platform_product_id,
            app_id=self.order.app_id, channel="android",
        )
        order.save(_service=True)
        apply_callback(goods(self.order), self.order.app_id)
        with self.at(3600):
            self.assertEqual(expire_due_orders(), 1)
        self.order.refresh_from_db()
        order.refresh_from_db()
        self.assertEqual(self.order.status, "fulfilled")
        self.assertEqual(order.status, "expired")
        self.assertEqual(EntitlementSource.objects.filter(status="active").count(), 1)

    def test_inflight_worker_cannot_revive_expired_task_or_query(self):
        task_id, lease = claim_task()
        with self.at(120), patch("payments.gateway.query_order") as query:
            self.assertFalse(run_task(task_id, lease))
            self.assertFalse(finish_task(task_id, lease, error="PLATFORM_PENDING"))
            query.assert_not_called()
        self.assertEqual(PaymentTask.objects.get().status, "done")

    def test_late_trusted_paid_callback_is_processed_once(self):
        with self.at(120):
            expire_user_orders(self.session.user)
            self.assertEqual(apply_callback(goods(self.order), self.order.app_id), "applied")
            self.assertEqual(apply_callback(goods(self.order), self.order.app_id), "applied")
        self.order.refresh_from_db()
        self.assertEqual(self.order.status, "fulfilled")
        self.assertEqual(EntitlementSource.objects.count(), 1)

    def test_expiring_old_order_never_releases_a_new_orders_reservation(self):
        with self.at(120):
            new_id = create_order(self.session.user, self.session, self.product.pk, "android", "replacement-order")["order"]["id"]
            prepare_payment(self.session.user, self.session, new_id, "replacement-prepare")
            expire_user_orders(self.session.user)
        reservation = OpeningReservation.objects.get()
        self.assertEqual(reservation.order_id, new_id)
        self.assertTrue(reservation.is_active)

    def test_command_retires_legacy_failed_tasks_for_closed_orders(self):
        self.order.status = "closed"
        self.order.save(_service=True)
        task = PaymentTask.objects.get()
        task.status = "failed"
        task.attempts = 8
        task.last_error_code = "INVALID_PLATFORM_MESSAGE"
        task.save(_service=True)
        with patch("payments.gateway.query_order") as query:
            call_command("expire_payment_orders", stdout=StringIO())
            query.assert_not_called()
        task.refresh_from_db()
        self.assertEqual((task.status, task.last_error_code), ("done", ""))
