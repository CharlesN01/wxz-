"""Cancel unpaid local orders on a fixed deadline, without a platform query."""
from datetime import timedelta

from django.db import transaction
from django.utils import timezone

from entitlements.services import _audit, _release_reservation, lock_reservation, lock_user
from .models import PAYMENT_WINDOW_SECONDS, Order, PaymentTask


def _finish_unpaid_tasks(order):
    count = 0
    for task in PaymentTask.objects.select_for_update().filter(order=order).exclude(status="done"):
        task.status = "done"
        task.last_error_code = ""
        task.lease_token = ""
        task.lease_until = None
        task.save(_service=True)
        count += 1
    return count


@transaction.atomic
def expire_user_orders(user, *, now=None):
    """Lock User -> reservation -> Order -> task, matching payment callbacks."""
    now = now or timezone.now()
    locked = lock_user(user)
    reservation = lock_reservation(locked)
    due = Order.objects.select_for_update().filter(
        user=locked, status__in=("created", "preparing"), paid_at__isnull=True,
        created_at__lte=now - timedelta(seconds=PAYMENT_WINDOW_SECONDS),
    ).order_by("id")
    count = 0
    for order in due:
        order.status = "expired"
        order.save(_service=True)
        if reservation and reservation.is_active and reservation.order_id == order.pk:
            _release_reservation(reservation, reason="order_timeout")
        _audit("payment_order_expired", user=locked, order_id=order.pk, timeoutSeconds=PAYMENT_WINDOW_SECONDS)
        count += 1
    # Also retire legacy failed tasks whose orders have already closed. This
    # never touches paid orders or reuses another order's purchase reservation.
    for order in Order.objects.select_for_update().filter(
        user=locked, status__in=("expired", "closed"), paid_at__isnull=True,
        pk__in=PaymentTask.objects.filter(status__in=("pending", "running", "failed")).values("order_id"),
    ).order_by("id"):
        stopped = _finish_unpaid_tasks(order)
        if stopped:
            _audit("payment_tasks_closed", user=locked, order_id=order.pk, stoppedTasks=stopped)
    return count


def expire_due_orders(*, limit=200):
    cutoff = timezone.now() - timedelta(seconds=PAYMENT_WINDOW_SECONDS)
    due_users = list(Order.objects.filter(
        status__in=("created", "preparing"), paid_at__isnull=True, created_at__lte=cutoff,
    ).order_by("created_at", "id").values_list("user_id", flat=True)[:limit])
    terminal_users = list(Order.objects.filter(
        status__in=("expired", "closed"), paid_at__isnull=True,
        tasks__status__in=("pending", "running", "failed"),
    ).order_by("created_at", "id").values_list("user_id", flat=True)[:limit])
    return sum(expire_user_orders(user_id) for user_id in dict.fromkeys(due_users + terminal_users))
