from rest_framework.response import Response

from common.api import PublicStudentAPIView
from content.serializers import validate_query_params
from distribution.services import resolve_agent_scene
from .serializers import GroupResourceQuery
from .models import GroupResourceConfiguration


class GroupResourceConfigurationView(PublicStudentAPIView):
    http_method_names = ("get", "head", "options")

    def get(self, request):
        query = validate_query_params(request.query_params, GroupResourceQuery)
        agent = resolve_agent_scene(query.get("scene", "")) if query.get("scene") else None
        agent_qr_url = agent.agent_wechat_qr.url if agent and agent.agent_wechat_qr else None
        configuration = GroupResourceConfiguration.current()
        if configuration is None or not configuration.is_enabled:
            payload = {"enabled": False}
            if "scene" in query:
                payload["agentWechatQrCode"] = request.build_absolute_uri(agent_qr_url) if agent_qr_url else None
            return Response(payload)
        qr_url = configuration.group_qr_code.url if configuration.group_qr_code else None
        payload = {
            "enabled": True,
            "groupQrCode": request.build_absolute_uri(qr_url) if qr_url else None,
            "wechatId": configuration.group_wechat_id,
            "claimCode": configuration.claim_code,
            "description": configuration.description,
            "announcement": configuration.announcement,
            "updatedAt": configuration.updated_at.isoformat(),
        }
        if "scene" in query:
            payload["agentWechatQrCode"] = request.build_absolute_uri(agent_qr_url) if agent_qr_url else None
        return Response(payload)
