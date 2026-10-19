import csv

from django.contrib import admin
from django.core import signing
from django.core.exceptions import PermissionDenied
from django.http import HttpResponse, HttpResponseRedirect
from django.template.response import TemplateResponse
from django.urls import path, reverse
from django.utils.html import format_html
from django.utils import timezone
from unfold.admin import ModelAdmin

from activation.models import ActivationRedemption
from entitlements.services import _audit
from .models import AgentProfile, AgentOrderAttribution, AgentVoucher
from .services import agent_performance_queryset, generate_agent_qr


@admin.register(AgentProfile)
class AgentProfileAdmin(ModelAdmin):
    list_display = ("display_name", "agent_code", "user", "status", "scene", "created_at", "qr_link")
    list_filter = ("status",)
    search_fields = ("display_name", "agent_code", "contact", "user__username")
    readonly_fields = ("scene", "created_by", "created_at", "updated_at", "disabled_at", "qr_image", "qr_link")
    fields = ("user", "agent_code", "display_name", "contact", "status", "scene", "qr_image", "created_by", "created_at", "updated_at", "disabled_at", "disabled_reason", "qr_link")
    actions = None

    def save_model(self, request, obj, form, change):
        if not change:
            obj.created_by = request.user
        else:
            previous = AgentProfile.objects.get(pk=obj.pk)
            if previous.status != obj.status:
                if obj.status == "disabled":
                    if not obj.disabled_reason.strip():
                        raise PermissionDenied("停用代理必须填写停用理由。")
                    obj.disabled_at = timezone.now()
                    _audit("agent_disabled", actor=request.user, agentId=str(obj.pk), reason=obj.disabled_reason.strip())
                else:
                    obj.disabled_at = None
                    obj.disabled_reason = ""
                    _audit("agent_enabled", actor=request.user, agentId=str(obj.pk))
        obj.save(_service=True)

    def has_delete_permission(self, request, obj=None):
        return False

    def has_add_permission(self, request):
        return request.user.has_perm("distribution.manage_agentprofile")

    def has_change_permission(self, request, obj=None):
        return request.user.has_perm("distribution.manage_agentprofile")

    def get_readonly_fields(self, request, obj=None):
        fields = list(super().get_readonly_fields(request, obj))
        if obj:
            fields.append("agent_code")
        return tuple(dict.fromkeys(fields))

    def get_urls(self):
        return [path("<uuid:agent_id>/generate-qr/", self.admin_site.admin_view(self.generate_qr_view), name="distribution_agent_generate_qr")] + super().get_urls()

    @admin.display(description="生成二维码")
    def qr_link(self, obj):
        if not obj or not obj.pk:
            return "未生成"
        if obj.qr_image:
            return format_html('<a href="{}" target="_blank">查看二维码</a> · <a href="{}">重新生成</a>', obj.qr_image.url, reverse("admin:distribution_agent_generate_qr", args=(obj.pk,)))
        return format_html('<a href="{}">生成二维码</a>', reverse("admin:distribution_agent_generate_qr", args=(obj.pk,)))

    def generate_qr_view(self, request, agent_id):
        if not request.user.has_perm("distribution.qrcode_agentprofile"):
            raise PermissionDenied("没有生成代理二维码的权限。")
        profile = AgentProfile.objects.get(pk=agent_id)
        back_url = reverse("admin:distribution_agentprofile_change", args=(agent_id,))
        context = {
            **self.admin_site.each_context(request), "opts": self.model._meta,
            "title": "确认生成代理二维码", "media": self.media,
            "back_url": back_url,
            "details": (("代理名称", profile.display_name), ("代理编号", profile.agent_code), ("小程序码参数", profile.scene)),
            "description": "确认后将调用微信接口生成二维码；不会改变代理编号或历史订单归因。",
        }
        if request.method == "POST":
            try:
                payload = signing.loads(request.POST.get("confirmation_token", ""), salt="distribution.qrcode.v1", max_age=1800)
            except (signing.BadSignature, ValueError, TypeError):
                raise PermissionDenied("确认凭证无效或已过期，请重新打开页面。") from None
            if payload != {"actor": request.user.pk, "agent": str(profile.pk)} or request.POST.get("confirm") != "yes":
                raise PermissionDenied("确认凭证与当前代理不匹配。")
            generate_agent_qr(request.user, agent_id)
            self.message_user(request, "代理二维码已生成。")
            return HttpResponseRedirect(back_url)
        context["confirmation_token"] = signing.dumps({"actor": request.user.pk, "agent": str(profile.pk)}, salt="distribution.qrcode.v1")
        return TemplateResponse(request, "admin/activation/confirmation.html", context)

@admin.register(AgentOrderAttribution)
class AgentOrderAttributionAdmin(ModelAdmin):
    list_display = ("order", "agent", "scene", "attributed_at")
    list_filter = ("agent",)
    search_fields = ("order__id", "agent__agent_code", "scene")
    readonly_fields = tuple(field.name for field in AgentOrderAttribution._meta.fields)

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


@admin.register(AgentVoucher)
class AgentVoucherAdmin(ModelAdmin):
    list_display = ("order", "mask", "state", "redeemed_by", "redeemed_at", "agent_name")
    list_filter = ("state",)
    search_fields = ("mask", "order__id", "redeemed_by__username", "order__agent_attribution__agent__agent_code")
    readonly_fields = tuple(field.name for field in AgentVoucher._meta.fields) + ("agent_name",)

    @admin.display(description="代理")
    def agent_name(self, obj):
        return obj.order.agent_attribution.agent.display_name

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


class DistributionRedemptionAdmin(ModelAdmin):
    list_display = ("agent", "order", "mask", "user", "redeemed_at")
    list_filter = ("agent_voucher__order__agent_attribution__agent",)
    search_fields = ("agent_voucher__mask", "agent_voucher__order__id", "user__username")
    readonly_fields = tuple(field.name for field in ActivationRedemption._meta.fields) + ("agent", "order", "mask")

    @admin.display(description="代理")
    def agent(self, obj):
        return obj.agent_voucher.order.agent_attribution.agent.display_name if obj.agent_voucher_id else "普通批次"

    @admin.display(description="订单")
    def order(self, obj):
        return obj.agent_voucher.order_id if obj.agent_voucher_id else "—"

    @admin.display(description="激活码掩码")
    def mask(self, obj):
        return obj.agent_voucher.mask if obj.agent_voucher_id else obj.code.mask

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False

    def get_urls(self):
        return [path("export/", self.admin_site.admin_view(self.export_view), name="distribution_redemption_export")] + super().get_urls()

    def export_view(self, request):
        if not request.user.has_perm("distribution.export_agentperformance"):
            raise PermissionDenied("没有导出代理业绩的权限。")
        queryset = agent_performance_queryset(agent_id=request.GET.get("agent") or None)
        response = HttpResponse(content_type="text/csv; charset=utf-8")
        response["Content-Disposition"] = 'attachment; filename="agent-redemptions.csv"'
        writer = csv.writer(response)
        writer.writerow(("代理", "订单号", "激活码掩码", "兑换用户", "兑换时间", "金额（分）", "支付状态"))
        for item in queryset.order_by("-redeemed_at"):
            voucher = item.agent_voucher
            order = voucher.order
            writer.writerow((order.agent_attribution.agent.display_name, order.pk, voucher.mask, item.user.username, item.redeemed_at.isoformat(), order.price_fen, order.status))
        return response
