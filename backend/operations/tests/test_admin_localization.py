import gettext
import json
import re
from pathlib import Path

from django.conf import settings
from django.contrib import admin
from django.contrib.admin.utils import label_for_field
from django.contrib.auth import get_user_model
from django.test import SimpleTestCase, TestCase
from django.urls import reverse
from django.utils.translation import gettext as translate, override

from accounts.models import WeChatIdentity
from entitlements.models import Product
from payments.models import Order, PaymentEvent, PaymentTask


class AdminLocalizationTests(SimpleTestCase):
    def test_registered_business_fields_and_columns_have_chinese_labels(self):
        for model, model_admin in admin.site._registry.items():
            if model._meta.app_label in {"auth", "admin"}:
                continue
            for field in model._meta.fields:
                if field.primary_key and str(field.verbose_name).lower() == "id":
                    continue  # Hidden/internal primary keys can retain the standard ID label.
                with self.subTest(model=model._meta.label, field=field.name):
                    self.assertRegex(str(field.verbose_name), r"[\u3400-\u9fff]")
            with override("zh-hans"):
                for column in model_admin.list_display:
                    label = str(label_for_field(column, model, model_admin))
                    with self.subTest(model=model._meta.label, column=column):
                        self.assertTrue(label == "ID" or re.search(r"[\u3400-\u9fff]", label), label)

    def test_compiled_catalog_matches_editable_source(self):
        folder = Path(settings.BASE_DIR) / "locale/zh_Hans/LC_MESSAGES"
        with (folder / "django.mo").open("rb") as stream:
            catalog = gettext.GNUTranslations(stream)
        msgid = None
        for line in (folder / "django.po").read_text(encoding="utf-8").splitlines():
            if line.startswith("msgid "):
                msgid = json.loads(line[6:])
            elif line.startswith("msgstr ") and msgid:
                self.assertEqual(catalog.gettext(msgid), json.loads(line[7:]), msgid)

    def test_framework_controls_resolve_in_chinese(self):
        with override("zh-hans"):
            for source, expected in (
                ("Select action", "选择操作"), ("Reset filters", "重置筛选"),
                ("Run", "执行"), ("Toggle sidebar", "展开或收起侧栏"),
            ):
                with self.subTest(source=source):
                    self.assertEqual(translate(source), expected)


class PaymentAdminChinesePageTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.actor = get_user_model().objects.create_superuser("localization-admin", password="test-only")
        cls.student = get_user_model().objects.create_user("localization-student")
        identity = WeChatIdentity.objects.create(
            user=cls.student, app_id="test-app", openid="test-localization-identity", encrypted_session_key="test-only",
        )
        product = Product.objects.create()
        cls.order = Order(
            user=cls.student, identity=identity, product=product, product_name=product.name,
            price_fen=product.price_fen, platform_product_id="test-vip", app_id="test-app", channel="android",
        )
        cls.order.save(_service=True)
        cls.task = PaymentTask(order=cls.order, kind="query")
        cls.task.save(_service=True)
        cls.event = PaymentEvent(
            key="localization-event", order=cls.order, kind="query", request_digest="test-digest",
            outcome="pending", details={"source": "test"},
        )
        cls.event.save(_service=True)

    def setUp(self):
        self.client.force_login(self.actor)

    def test_order_task_and_event_list_headers_and_filters(self):
        cases = (
            (Order, {"status__exact": "created"}, ("订单编号", "学员", "金额（分）", "支付渠道", "订单状态", "创建时间")),
            (PaymentTask, {"status__exact": "pending"}, ("关联订单", "任务类型", "任务状态", "执行次数", "下次执行时间", "最近错误码")),
            (PaymentEvent, {"outcome__exact": "pending"}, ("事件编号", "关联订单", "事件类型", "处理结果", "错误码", "创建时间")),
        )
        for model, filters, labels in cases:
            with self.subTest(model=model._meta.label):
                response = self.client.get(reverse(f"admin:payments_{model._meta.model_name}_changelist"), filters)
                self.assertEqual(response.status_code, 200)
                for label in labels:
                    self.assertContains(response, label)
                self.assertNotContains(response, "Reset filters")
                self.assertNotContains(response, "Order object (")

    def test_readonly_task_detail_and_relation_preserve_navigation(self):
        response = self.client.get(reverse("admin:payments_paymenttask_change", args=(self.task.pk,)))
        self.assertEqual(response.status_code, 200)
        for label in ("关联订单", "任务类型", "任务状态", "执行次数", "下次执行时间", "租约到期时间", "最近错误码", "创建时间", "更新时间"):
            self.assertContains(response, label)
        self.assertContains(response, f"支付任务 #{self.task.pk}")
        self.assertContains(response, f"订单 {self.order.pk}")
        self.assertContains(response, reverse("admin:payments_order_change", args=(self.order.pk,)))
        self.assertNotContains(response, "PaymentTask object (")
        self.assertNotContains(response, 'name="_save"')

    def test_bulk_action_placeholder_and_filter_captions_are_translated(self):
        response = self.client.get(reverse("admin:content_question_changelist"))
        self.assertContains(response, "选择操作")
        self.assertNotContains(response, "Select action")
        self.assertNotContains(response, "Reset filters")

    def test_empty_filtered_orders_offer_chinese_reset(self):
        response = self.client.get(reverse("admin:payments_order_changelist"), {"status__exact": "review"})
        self.assertContains(response, "重置筛选")
        self.assertNotContains(response, "Reset filters")
