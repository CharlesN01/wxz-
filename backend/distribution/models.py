import uuid

from django.conf import settings
from django.core.exceptions import ValidationError
from django.core.validators import FileExtensionValidator, RegexValidator
from django.db import models
from django.utils import timezone

from entitlements.models import ServiceOnlyModel
from .qr import PublicAgentWechatQRStorage, agent_wechat_qr_upload_to, validate_agent_wechat_qr


AGENT_CODE_VALIDATOR = RegexValidator(
    r"^[A-Z0-9][A-Z0-9_-]{2,31}$",
    "代理编号只能使用 3-32 位 ASCII 大写字母、数字、下划线或短横线。",
)


class AgentProfile(ServiceOnlyModel):
    STATUS_CHOICES = (("active", "启用"), ("disabled", "停用"))
    id = models.UUIDField("代理记录编号", primary_key=True, default=uuid.uuid4, editable=False)
    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="agent_profile", verbose_name="后台账号")
    agent_code = models.CharField("代理编号", max_length=32, unique=True, validators=(AGENT_CODE_VALIDATOR,))
    display_name = models.CharField("代理名称", max_length=120)
    contact = models.CharField("联系方式", max_length=200, blank=True)
    status = models.CharField("状态", max_length=16, choices=STATUS_CHOICES, default="active")
    scene = models.CharField("小程序码参数", max_length=40, unique=True, editable=False)
    qr_image = models.FileField("专属二维码", upload_to="distribution/qr/", blank=True)
    agent_wechat_qr = models.FileField(
        "代理微信二维码", upload_to=agent_wechat_qr_upload_to, blank=True,
        storage=PublicAgentWechatQRStorage(),
        validators=(FileExtensionValidator(allowed_extensions=("png", "jpg", "jpeg", "webp")), validate_agent_wechat_qr),
    )
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="created_agent_profiles", verbose_name="创建者")
    created_at = models.DateTimeField("创建时间", auto_now_add=True)
    updated_at = models.DateTimeField("更新时间", auto_now=True)
    disabled_at = models.DateTimeField("停用时间", null=True, blank=True)
    disabled_reason = models.CharField("停用理由", max_length=500, blank=True)

    class Meta:
        verbose_name = "代理资料"
        verbose_name_plural = verbose_name
        ordering = ("-created_at", "id")
        permissions = (
            ("manage_agentprofile", "可以创建和管理代理"),
            ("qrcode_agentprofile", "可以生成和下载代理二维码"),
            ("upload_agentwechatqr_agentprofile", "可以上传代理微信二维码"),
        )
        constraints = (
            models.CheckConstraint(condition=models.Q(status__in=("active", "disabled")), name="distribution_agent_status"),
            models.CheckConstraint(condition=models.Q(scene__startswith="a="), name="distribution_agent_scene"),
        )

    def save(self, *args, _service=False, **kwargs):
        if self.pk:
            previous = type(self).objects.filter(pk=self.pk).first()
            if previous and previous.agent_code != self.agent_code:
                raise ValidationError("代理编号创建后不可修改。")
            if previous and previous.scene != self.scene:
                raise ValidationError("代理归因标识创建后不可修改。")
        if not self.scene:
            self.scene = "a=" + self.agent_code
        return super().save(*args, _service=_service, **kwargs)

    def __str__(self):
        return f"{self.display_name} ({self.agent_code})"


class AgentOrderAttribution(ServiceOnlyModel):
    id = models.UUIDField("归因记录编号", primary_key=True, default=uuid.uuid4, editable=False)
    order = models.OneToOneField("payments.Order", on_delete=models.PROTECT, related_name="agent_attribution", verbose_name="订单")
    agent = models.ForeignKey(AgentProfile, on_delete=models.PROTECT, related_name="attributions", verbose_name="代理")
    scene = models.CharField("归因标识", max_length=40)
    attributed_at = models.DateTimeField("归因时间", default=timezone.now)
    created_at = models.DateTimeField("创建时间", auto_now_add=True)

    class Meta:
        verbose_name = "订单代理归因"
        verbose_name_plural = verbose_name
        ordering = ("-created_at", "id")


class AgentVoucher(ServiceOnlyModel):
    STATE_CHOICES = (("issued", "已生成待兑换"), ("redeemed", "已兑换"), ("disabled", "已禁用"))
    id = models.UUIDField("订单激活码编号", primary_key=True, default=uuid.uuid4, editable=False)
    order = models.OneToOneField("payments.Order", on_delete=models.PROTECT, related_name="agent_voucher", verbose_name="订单")
    digest = models.CharField("激活码摘要", max_length=64, unique=True)
    mask = models.CharField("激活码掩码", max_length=32)
    state = models.CharField("状态", max_length=16, choices=STATE_CHOICES, default="issued")
    redeemed_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, null=True, blank=True, related_name="redeemed_agent_vouchers", verbose_name="兑换学员")
    redeemed_at = models.DateTimeField("兑换时间", null=True, blank=True)
    disabled_at = models.DateTimeField("禁用时间", null=True, blank=True)
    disabled_reason = models.CharField("禁用理由", max_length=500, blank=True)
    created_at = models.DateTimeField("生成时间", auto_now_add=True)

    class Meta:
        verbose_name = "订单激活码"
        verbose_name_plural = verbose_name
        ordering = ("-created_at", "id")
        permissions = (("view_agentperformance", "可以查看代理业绩"), ("export_agentperformance", "可以导出代理激活明细"))
        constraints = (
            models.CheckConstraint(
                condition=(models.Q(state="redeemed", redeemed_by__isnull=False, redeemed_at__isnull=False) | models.Q(state__in=("issued", "disabled"), redeemed_by__isnull=True, redeemed_at__isnull=True)),
                name="distribution_voucher_used_state",
            ),
        )

    def __str__(self):
        return self.mask
