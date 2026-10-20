import uuid
from django.conf import settings
from django.db import models
from django.utils import timezone
from entitlements.models import SCOPE, ServiceOnlyModel


def order_id():
    return uuid.uuid4().hex


class Order(ServiceOnlyModel):
    STATES = tuple((v, label) for v, label in (
        ("created", "本地待支付"), ("preparing", "平台处理中"), ("paid", "已付款待发权"),
        ("code_pending", "已付款待领取激活码"), ("code_issued", "激活码已生成"),
        ("code_redeemed", "激活码已兑换"), ("fulfilled", "已开通"), ("closed", "平台确认关闭"),
        ("refunded", "平台已退款"), ("review", "待人工核查")))
    id = models.CharField("订单编号", primary_key=True, max_length=32, default=order_id, editable=False)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="payment_orders", verbose_name="学员")
    identity = models.ForeignKey("accounts.WeChatIdentity", on_delete=models.PROTECT, verbose_name="微信身份")
    product = models.ForeignKey("entitlements.Product", on_delete=models.PROTECT, verbose_name="商品")
    product_name = models.CharField("商品名称", max_length=120)
    scope = models.CharField("权益范围", max_length=32, default=SCOPE)
    price_fen = models.PositiveIntegerField("金额（分）")
    platform_product_id = models.CharField("平台商品编号", max_length=128)
    app_id = models.CharField("小程序 AppID", max_length=64)
    environment = models.PositiveSmallIntegerField("支付环境（0 正式 / 1 沙箱）", default=0)
    channel = models.CharField("支付渠道", max_length=16, choices=(("android", "安卓"), ("ios", "苹果")))
    status = models.CharField("订单状态", max_length=20, choices=STATES, default="created")
    prepared_at = models.DateTimeField("支付准备时间", null=True, blank=True)
    prepared_session = models.ForeignKey("accounts.StudentSession", on_delete=models.PROTECT, null=True, blank=True, verbose_name="支付准备会话")
    sign_data = models.TextField("支付签名数据", blank=True)
    configuration_digest = models.CharField("支付配置摘要", max_length=64, blank=True)
    platform_order_id = models.CharField("平台订单编号", max_length=128, blank=True)
    transaction_id = models.CharField("平台交易编号", max_length=128, blank=True)
    last_platform_status = models.IntegerField("最近平台状态码", null=True, blank=True)
    paid_at = models.DateTimeField("付款确认时间", null=True, blank=True)
    fulfilled_at = models.DateTimeField("权益开通时间", null=True, blank=True)
    refunded_at = models.DateTimeField("退款时间", null=True, blank=True)
    review_reason = models.CharField("人工核查原因", max_length=200, blank=True)
    created_at = models.DateTimeField("创建时间", auto_now_add=True)
    updated_at = models.DateTimeField("更新时间", auto_now=True)

    def __str__(self):
        return f"订单 {self.pk}"

    class Meta:
        verbose_name = "付款订单"
        verbose_name_plural = verbose_name
        ordering = ("-created_at", "id")
        constraints = (
            models.CheckConstraint(condition=models.Q(price_fen__gt=0), name="payment_positive_price"),
            models.CheckConstraint(condition=models.Q(scope=SCOPE), name="payment_single_scope"),
            models.CheckConstraint(condition=models.Q(environment__in=(0, 1)), name="payment_environment"),
            models.UniqueConstraint(fields=("platform_order_id",), condition=~models.Q(platform_order_id=""), name="payment_platform_order_unique"),
            models.UniqueConstraint(fields=("transaction_id",), condition=~models.Q(transaction_id=""), name="payment_transaction_unique"),
        )


class PaymentTask(ServiceOnlyModel):
    order = models.ForeignKey(Order, on_delete=models.PROTECT, related_name="tasks", verbose_name="关联订单")
    kind = models.CharField("任务类型", max_length=16, choices=(("query", "查单"), ("deliver", "通知发货")))
    status = models.CharField("任务状态", max_length=16, choices=(("pending", "待执行"), ("running", "执行中"), ("done", "完成"), ("failed", "需核查")), default="pending")
    attempts = models.PositiveIntegerField("执行次数", default=0)
    next_run_at = models.DateTimeField("下次执行时间", default=timezone.now)
    lease_token = models.CharField("任务租约凭证", max_length=64, blank=True)
    lease_until = models.DateTimeField("租约到期时间", null=True, blank=True)
    last_error_code = models.CharField("最近错误码", max_length=64, blank=True)
    created_at = models.DateTimeField("创建时间", auto_now_add=True)
    updated_at = models.DateTimeField("更新时间", auto_now=True)

    def __str__(self):
        return f"支付任务 #{self.pk}"

    class Meta:
        verbose_name = "支付补偿任务"
        verbose_name_plural = verbose_name
        constraints = (models.UniqueConstraint(fields=("order", "kind"), name="payment_unique_task"),)
        permissions = (("reschedule_paymenttask", "可以确认并重调度失败支付任务"),)


class PaymentEvent(ServiceOnlyModel):
    key = models.CharField("事件编号", primary_key=True, max_length=64)
    order = models.ForeignKey(Order, on_delete=models.PROTECT, null=True, blank=True, related_name="events", verbose_name="关联订单")
    kind = models.CharField("事件类型", max_length=64)
    external_id = models.CharField("平台事件编号", max_length=128, blank=True)
    request_digest = models.CharField("请求摘要", max_length=64)
    outcome = models.CharField("处理结果", max_length=16)
    error_code = models.CharField("错误码", max_length=64, blank=True)
    details = models.JSONField("事件详情", default=dict)
    created_at = models.DateTimeField("创建时间", auto_now_add=True)

    def __str__(self):
        return f"支付事件 {self.pk}"

    class Meta:
        verbose_name = "支付平台事件"
        verbose_name_plural = verbose_name
        ordering = ("-created_at", "key")


class AccessTokenCache(ServiceOnlyModel):
    app_id = models.CharField(primary_key=True, max_length=64)
    ciphertext = models.TextField(blank=True)
    expires_at = models.DateTimeField(null=True, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "微信接口令牌缓存（加密）"
        verbose_name_plural = verbose_name
