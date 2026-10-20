AGENT_SELF_SERVICE_GROUP = "代理本人"


def is_agent_self_service_user(user):
    if not user.is_authenticated:
        return False
    cached = getattr(user, "_is_agent_self_service_user", None)
    if cached is None:
        cached = user.groups.filter(name=AGENT_SELF_SERVICE_GROUP).exists()
        user._is_agent_self_service_user = cached
    return cached


def scope_to_agent_user(request, queryset, agent_field="pk"):
    if not is_agent_self_service_user(request.user):
        return queryset
    from .models import AgentProfile

    profile_id = AgentProfile.objects.filter(user_id=request.user.pk).values_list("pk", flat=True).first()
    if profile_id is None:
        return queryset.none()
    return queryset.filter(**{agent_field: profile_id})
