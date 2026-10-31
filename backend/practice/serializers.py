from rest_framework import serializers


class StrictSerializer(serializers.Serializer):
    def to_internal_value(self, data):
        if not isinstance(data, dict):
            raise serializers.ValidationError({"non_field_errors": ["请提供 JSON 对象。"]})
        unknown = set(data) - set(self.fields)
        if unknown:
            raise serializers.ValidationError({key: "不支持的字段。" for key in unknown})
        return super().to_internal_value(data)


class StrictSlug(serializers.SlugField):
    def to_internal_value(self, data):
        if not isinstance(data, str):
            self.fail("invalid")
        return super().to_internal_value(data)


class StrictChoice(serializers.ChoiceField):
    def to_internal_value(self, data):
        if not isinstance(data, str):
            self.fail("invalid_choice", input="非字符串")
        return super().to_internal_value(data)


class StrictInteger(serializers.IntegerField):
    def to_internal_value(self, data):
        if not isinstance(data, int) or isinstance(data, bool):
            self.fail("invalid")
        return super().to_internal_value(data)


class StrictUUID(serializers.UUIDField):
    def to_internal_value(self, data):
        if not isinstance(data, str):
            self.fail("invalid")
        return super().to_internal_value(data)


class RoundRequest(StrictSerializer):
    source = StrictChoice(choices=("literature", "classical"))
    categoryId = StrictSlug(max_length=64, required=False, allow_null=True)
    articleId = StrictSlug(max_length=64, required=False, allow_null=True)
    type = StrictChoice(choices=("fact", "word", "translation"), required=False, allow_null=True)
    mode = StrictChoice(choices=("writing", "reciting"))

    def validate(self, values):
        if values["source"] == "literature":
            if values.get("articleId") is not None:
                raise serializers.ValidationError({"articleId": "文学常识范围不能指定文言篇目。"})
            if values.get("type") not in (None, "fact"):
                raise serializers.ValidationError({"type": "文学分类只支持 fact。"})
        elif values.get("categoryId") is not None:
            raise serializers.ValidationError({"categoryId": "文言文范围不能指定文学分类。"})
        for key in ("categoryId", "articleId", "type"):
            values.setdefault(key, None)
        return values


class ResumeRequest(RoundRequest):
    board = StrictChoice(choices=("sequence", "random"), required=False)
    questionId = StrictSlug(max_length=64)
    completed = serializers.BooleanField(required=False, default=False)
    roundId = StrictUUID(required=False, allow_null=True)
    groupIndex = StrictInteger(min_value=1, max_value=10000, required=False, allow_null=True)
    baseVersion = StrictInteger(min_value=0, max_value=2147483646)

    def validate(self, values):
        values = super().validate(values)
        values.setdefault("roundId", None)
        values.setdefault("groupIndex", None)
        values.setdefault("board", "random" if values["roundId"] is not None else "sequence")
        if (values["roundId"] is None) != (values["groupIndex"] is None):
            raise serializers.ValidationError({"groupIndex": "随机续学必须同时提供轮次和组号。"})
        if values["roundId"] is not None:
            values["roundId"] = str(values["roundId"])
        if values["board"] == "random" and values["roundId"] is None:
            raise serializers.ValidationError({"board": "随机练习续学必须提供轮次。"})
        if values["board"] == "sequence" and values["roundId"] is not None:
            raise serializers.ValidationError({"board": "顺序练习续学不能提供轮次。"})
        return values


class ResumeQuery(StrictSerializer):
    board = StrictChoice(choices=("sequence", "random"), required=False)
    source = StrictChoice(choices=("literature", "classical"), required=False)
    categoryId = StrictSlug(max_length=64, required=False, allow_null=True)
    articleId = StrictSlug(max_length=64, required=False, allow_null=True)
    type = StrictChoice(choices=("fact", "word", "translation"), required=False, allow_null=True)

    def validate(self, values):
        source = values.get("source")
        values.setdefault("categoryId", None)
        values.setdefault("articleId", None)
        values.setdefault("type", None)
        values.setdefault("board", "sequence")
        if source == "literature":
            if values["articleId"] is not None:
                raise serializers.ValidationError({"articleId": "文学常识范围不能指定文言篇目。"})
            if values["type"] not in (None, "fact"):
                raise serializers.ValidationError({"type": "文学分类只支持 fact。"})
        elif source == "classical" and values["categoryId"] is not None:
            raise serializers.ValidationError({"categoryId": "文言文范围不能指定文学分类。"})
        elif source is None and (values["categoryId"] is not None or values["articleId"] is not None or values["type"] is not None):
            raise serializers.ValidationError({"source": "指定续学范围时必须同时提供 source。"})
        return values
