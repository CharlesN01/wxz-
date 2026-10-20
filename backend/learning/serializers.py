from rest_framework import serializers


class StrictInteger(serializers.IntegerField):
    def to_internal_value(self, data):
        if not isinstance(data, int) or isinstance(data, bool):
            self.fail("invalid")
        return super().to_internal_value(data)


class StrictBoolean(serializers.BooleanField):
    def to_internal_value(self, data):
        if not isinstance(data, bool):
            self.fail("invalid")
        return data


class StrictInput(serializers.Serializer):
    def to_internal_value(self, data):
        if isinstance(data, dict) and set(data) - set(self.fields):
            raise serializers.ValidationError({"fields": "不支持的请求字段。"})
        return super().to_internal_value(data)


class QuestionStateInput(StrictInput):
    favorite = StrictBoolean(required=False)
    mastered = StrictBoolean(required=False)
    baseVersion = StrictInteger(min_value=0, max_value=9223372036854775806)

    def validate(self, data):
        if not ({"favorite", "mastered"} & data.keys()):
            raise serializers.ValidationError("至少指定收藏或掌握状态。")
        return data


class PreferenceInput(StrictInput):
    mode = serializers.ChoiceField(choices=("writing", "reciting"), required=False)
    dailyTarget = StrictInteger(min_value=1, max_value=1000, required=False)
    baseVersion = StrictInteger(min_value=0, max_value=9223372036854775806)

    def validate(self, data):
        if not ({"mode", "dailyTarget"} & data.keys()):
            raise serializers.ValidationError("至少指定一个学习偏好。")
        return data


class StrictUUID(serializers.UUIDField):
    def to_internal_value(self, data):
        if not isinstance(data, str):
            self.fail("invalid")
        value = super().to_internal_value(data)
        if str(value) != data.lower():
            self.fail("invalid")
        return value


class StudyTimeInput(StrictInput):
    sessionId = StrictUUID()
    sequence = StrictInteger(min_value=0, max_value=2147483646)
    elapsedSeconds = StrictInteger(min_value=0, max_value=60)
