from django.contrib import admin
from django.core import signing
from django.core.exceptions import PermissionDenied
from django.http import HttpResponseRedirect
from django.template.response import TemplateResponse
from django.urls import path, reverse
from django.utils import timezone
from unfold.admin import ModelAdmin

from operations.admin_ui import action_group, action_link
from .admin_access import is_agent_self_service_user, scope_to_agent_user
from entitlements.services import _audit
from .models import AgentProfile, AgentOrderAttribution, AgentVoucher
from .services import generate_agent_qr


@admin.register(AgentProfile)
class AgentProfileAdmin(ModelAdmin):
    list_display = ("display_name", "agent_code", "user", "status", "scene", "created_at", "qr_link")
    list_filter = ("status",)
    search_fields = ("display_name", "agent_code", "contact", "user__username")
    readonly_fields = ("scene", "created_by", "created_at", "updated_at", "disabled_at", "qr_image", "qr_link")
    fields = ("user", "agent_code", "display_name", "contact", "status", "scene", "qr_image", "created_by", "created_at", "updated_at", "disabled_at", "disabled_reason", "qr_link")
    actions = None

    def get_queryset(self, request):
        return scope_to_agent_user(request, super().get_queryset(request))

    def has_view_permission(self, request, obj=None):
        allowed = super().has_view_permission(request, obj)
        if not allowed or obj is None or not is_agent_self_service_user(request.user):
            return allowed
        return obj.user_id == request.user.pk

    def get_list_display(self, request):
        fields = list(super().get_list_display(request))
        if is_agent_self_service_user(request.user):
            fields[fields.index("qr_link")] = "qr_link_for_agent"
        return fields

    def get_fields(self, request, obj=None):
        fields = list(super().get_fields(request, obj))
        if is_agent_self_service_user(request.user):
            fields[fields.index("qr_link")] = "qr_link_for_agent"
        return fields

    @admin.display(description="专属二维码")
    def qr_link_for_agent(self, obj):
        if not obj.qr_image:
            return "二维码尚未生成"
        return action_link(obj.qr_image.url, "查看二维码", new_tab=True)

    def has_delete_permission(self, request, obj=None):
        return False
    def has_add_permission(self, request):
        return not is_agent_self_service_user(request.user) and request.user.has_perm("distribution.manage_agentprofile")

    def has_change_permission(self, request, obj=None):
        if is_agent_self_service_user(request.user):
            return False
        return request.user.has_perm("distribution.manage_agentprofile")

    def get_readonly_fields(self, request, obj=None):
        if is_agent_self_service_user(request.user):
            return tuple(field.name for field in self.model._meta.fields) + ("qr_link_for_agent",)
        fields = list(super().get_readonly_fields(request, obj))
        if obj:
            fields.append("agent_code")
        return tuple(dict.fromkeys(fields))

    def save_model(self, request, obj, form, change):
        if is_agent_self_service_user(request.user):
            raise PermissionDenied("代理本人只能查看资料，不能修改。")
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

    def get_urls(self):
        return [path("<uuid:agent_id>/generate-qr/", self.admin_site.admin_view(self.generate_qr_view), name="distribution_agent_generate_qr")] + super().get_urls()

    @admin.display(description="生成二维码")
    def qr_link(self, obj):
        if not obj or not obj.pk:
            return "未生成"
        if obj.qr_image:
            return action_group(
                action_link(obj.qr_image.url, "查看二维码", new_tab=True),
                action_link(reverse("admin:distribution_agent_generate_qr", args=(obj.pk,)), "重新生成", variant="primary"),
            )
        return action_link(reverse("admin:distribution_agent_generate_qr", args=(obj.pk,)), "生成二维码", variant="primary")

    def generate_qr_view(self, request, agent_id):
        if is_agent_self_service_user(request.user) or not request.user.has_perm("distribution.qrcode_agentprofile"):
            raise PermissionDenied("没有生成代理二维码的权限。")
        profile = self.get_queryset(request).filter(pk=agent_id).first()
        if profile is None:
            raise PermissionDenied("没有此代理资料的访问权限。")
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

    def get_queryset(self, request):
        return scope_to_agent_user(request, super().get_queryset(request), "agent_id")

    def get_list_filter(self, request):
        if is_agent_self_service_user(request.user):
            return ()
        return super().get_list_filter(request)

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

    def get_queryset(self, request):
        return scope_to_agent_user(
            request,
            super().get_queryset(request),
            "order__agent_attribution__agent_id",
        )

    @admin.display(description="代理")
    def agent_name(self, obj):
        return obj.order.agent_attribution.agent.display_name

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False
