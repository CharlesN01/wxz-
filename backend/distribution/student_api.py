from rest_framework import serializers
from rest_framework.parsers import JSONParser
from rest_framework.response import Response

from common.api import StudentAPIView
from common.idempotency import require_key
from common.errors import BusinessError
from .services import reveal_order_voucher


class EmptyInput(serializers.Serializer):
    def to_internal_value(self, data):
        if data not in ({}, None):
            raise serializers.ValidationError({"fields": "请求体必须为空对象。"})
        return {}


class ActivationCodeRevealView(StudentAPIView):
    parser_classes = (JSONParser,)

    def post(self, request, order_id):
        serializer = EmptyInput(data=request.data)
        serializer.is_valid(raise_exception=True)
        return Response(reveal_order_voucher(request.user, order_id, require_key(request.headers.get("Idempotency-Key"))), headers={"Cache-Control": "no-store, private"})
