import re
import secrets
import json
from urllib.request import Request, urlopen
from datetime import timedelta

from django.conf import settings
from django.core.files.base import ContentFile
from django.core.exceptions import ValidationError
from django.db import transaction
from django.utils import timezone

from common import idempotency
from common.errors import BusinessError
from entitlements.services import _audit, _require_admin, lock_reservation, lock_user
from activation.services import code_digest, _new_code

from .models import AgentProfile, AgentVoucher, AgentOrderAttribution


SCENE_RE = re.compile(r"^a=([A-Z0-9][A-Z0-9_-]{2,31})$", re.ASCII)


def normalize_scene(value):
    if not isinstance(value, str) or len(value) > 40:
        return ""
    raw = value.strip()
    if not raw[:2].lower() == "a=":
        return ""
    code = raw[2:].upper()
    return "a=" + code if re.fullmatch(r"[A-Z0-9][A-Z0-9_-]{2,31}", code, re.ASCII) else ""


def resolve_agent_scene(value):
    scene = normalize_scene(value)
    if not scene:
        return None
    return AgentProfile.objects.filter(scene=scene, status="active").first()


def create_agent(actor, user, agent_code, display_name, contact=""):
    _require_admin(actor, "distribution.manage_agentprofile")
    agent_code = str(agent_code or "").strip().upper()
    if not re.fullmatch(r"[A-Z0-9][A-Z0-9_-]{2,31}", agent_code, re.ASCII):
        raise BusinessError("INVALID_AGENT_CODE", "代理编号格式无效。")
    if not isinstance(display_name, str) or not display_name.strip() or len(display_name.strip()) > 120:
        raise BusinessError("INVALID_AGENT_NAME", "代理名称不能为空且最多 120 字。")
    if AgentProfile.objects.filter(agent_code=agent_code).exists():
        raise BusinessError("AGENT_CODE_EXISTS", "代理编号已存在。", 409)
    profile = AgentProfile(user=user, agent_code=agent_code, display_name=display_name.strip(), contact=str(contact or "").strip(), scene="a=" + agent_code, created_by=actor)
    profile.save(_service=True)
    _audit("agent_created", actor=actor, agentId=str(profile.pk), agentCode=profile.agent_code)
    return profile


@transaction.atomic
def generate_agent_qr(actor, agent_id):
    _require_admin(actor, "distribution.qrcode_agentprofile")
    if not getattr(settings, "AGENT_QRCODE_ENABLED", False):
        raise BusinessError("AGENT_QRCODE_UNAVAILABLE", "代理二维码功能暂未开启。", 503)
    try:
        profile = AgentProfile.objects.select_for_update().get(pk=agent_id)
    except (AgentProfile.DoesNotExist, ValidationError, ValueError) as error:
        raise BusinessError("NOT_FOUND", "代理不存在。", 404) from error
    from payments.gateway import access_token
    token = access_token(settings.WECHAT_APP_ID)
    body = json.dumps({"scene": profile.scene, "page": "pages/home/index", "check_path": False, "env_version": "trial"}, separators=(",", ":")).encode()
    request = Request("https://api.weixin.qq.com/wxa/getwxacodeunlimit?access_token=" + token, data=body, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urlopen(request, timeout=8) as response:
            content = response.read(2 * 1024 * 1024 + 1)
        if len(content) > 2 * 1024 * 1024:
            raise ValueError()
        if content.startswith(b"\x89PNG"):
            filename = "agent-" + profile.agent_code + ".png"
        elif content.startswith(b"\xff\xd8\xff"):
            filename = "agent-" + profile.agent_code + ".jpg"
        else:
            raise ValueError()
    except Exception as error:
        raise BusinessError("AGENT_QRCODE_FAILED", "微信小程序码生成失败，请稍后重试。", 503) from error
    profile.qr_image.save(filename, ContentFile(content), save=False)
    profile.save(_service=True)
    _audit("agent_qrcode_generated", actor=actor, agentId=str(profile.pk), scene=profile.scene)
    return profile


@transaction.atomic
def attribute_order(order, scene):
    agent = resolve_agent_scene(scene)
    if not agent:
        if scene:
            raise BusinessError("INVALID_AGENT_SCENE", "代理二维码无效或已停用。", 409)
        return None
    attribution = AgentOrderAttribution(order=order, agent=agent, scene=agent.scene)
    attribution.save(_service=True)
    _audit("agent_order_attributed", user=order.user, order_id=order.pk, agentId=str(agent.pk), scene=agent.scene)
    return attribution


def has_agent_order(order):
    return AgentOrderAttribution.objects.filter(order_id=order.pk).exists()


@transaction.atomic
def reveal_order_voucher(user, order_id, key):
    from payments.models import Order

    locked = lock_user(user)
    order = Order.objects.select_for_update().filter(pk=order_id, user=locked).first()
    if order is None:
        raise BusinessError("NOT_FOUND", "订单不存在。", 404)
    if not AgentOrderAttribution.objects.filter(order=order).exists():
        raise BusinessError("NOT_AGENT_ORDER", "该订单不是代理激活码订单。", 409)
    if order.status not in ("code_pending", "code_issued", "code_redeemed"):
        raise BusinessError("PAYMENT_NOT_CONFIRMED", "支付尚未确认，暂时不能领取激活码。", 409)
    payload = {"orderId": order.pk}
    previous = idempotency.lookup(locked, "agent-voucher-reveal", key, payload)
    existing = AgentVoucher.objects.select_for_update().filter(order=order).first()
    if existing:
        raise BusinessError("ACTIVATION_CODE_ALREADY_REVEALED", "激活码已展示过，系统只保存掩码，无法再次返回原码。", 409, fields={"mask": existing.mask, "status": order.status})
    if previous:
        raise BusinessError("ACTIVATION_CODE_ALREADY_REVEALED", "激活码已展示过，系统只保存掩码，无法再次返回原码。", 409)
    if order.status == "code_redeemed":
        raise BusinessError("ACTIVATION_CODE_ALREADY_REDEEMED", "激活码已经兑换。", 409)
    raw, digest, mask = _new_code()
    voucher = AgentVoucher(order=order, digest=digest, mask=mask)
    voucher.save(_service=True)
    order.status = "code_issued"
    order.save(_service=True)
    idempotency.remember(locked, "agent-voucher-reveal", key, payload, {"orderId": order.pk, "mask": mask, "status": order.status})
    _audit("agent_voucher_issued", user=locked, order_id=order.pk, voucherId=str(voucher.pk), digest=digest, mask=mask)
    return {"order": {"id": order.pk, "status": order.status}, "activationCode": raw, "mask": mask, "redeemable": True}


@transaction.atomic
def release_voucher_reservation(voucher):
    user = lock_user(voucher.order.user_id)
    reservation = lock_reservation(user, voucher.order.scope)
    if reservation and reservation.is_active and reservation.order_id == voucher.order_id:
        reservation.released_at = timezone.now()
        reservation.release_reason = "voucher_redeemed"
        reservation.save(_service=True)
        _audit("opening_released", user=user, order_id=voucher.order_id, scope=voucher.order.scope, reason="voucher_redeemed")


@transaction.atomic
def disable_voucher_for_refund(order, reason="平台退款"):
    voucher = AgentVoucher.objects.select_for_update().filter(order=order).first()
    if not voucher or voucher.state != "issued":
        return voucher
    voucher.state = "disabled"
    voucher.disabled_at = timezone.now()
    voucher.disabled_reason = reason[:500]
    voucher.save(_service=True)
    return voucher


def agent_performance_queryset(agent_id=None, start=None, end=None):
    from activation.models import ActivationRedemption

    queryset = ActivationRedemption.objects.filter(agent_voucher__isnull=False).select_related("agent_voucher__order__agent_attribution__agent", "user")
    if agent_id:
        queryset = queryset.filter(agent_voucher__order__agent_attribution__agent_id=agent_id)
    if start:
        queryset = queryset.filter(redeemed_at__gte=start)
    if end:
        queryset = queryset.filter(redeemed_at__lt=end)
    return queryset
