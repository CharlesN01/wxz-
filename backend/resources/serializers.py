from rest_framework import serializers


class GroupResourceQuery(serializers.Serializer):
    scene = serializers.RegexField(r"^a=[A-Z0-9][A-Z0-9_-]{2,31}$", required=False)
