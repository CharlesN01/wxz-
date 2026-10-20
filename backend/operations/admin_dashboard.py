from django.urls import reverse

from config.admin_navigation import is_agent_account


def _can(user, *permissions):
    return any(user.has_perm(permission) for permission in permissions)


def dashboard_callback(request, context):
    from content.models import Question
    from distribution.models import AgentProfile
    from feedback.models import Feedback
    from payments.models import Order, PaymentTask
    from writing.models import WritingContent
    from writing.import_services import has_import_permission

    user = request.user
    cards = []
    links = []

    if has_import_permission(user):
        links.append({"title": "导入应用文", "url": reverse("admin:writing_writingcontent_import")})

    if user.has_perm("content.view_question"):
        cards.append({
            "title": "待发布题目",
            "count": Question.objects.filter(is_published=False).count(),
            "url": reverse("admin:content_question_changelist") + "?is_published__exact=0",
        })
    if user.has_perm("writing.view_writingcontent"):
        cards.append({
            "title": "待发布应用文",
            "count": WritingContent.objects.filter(is_published=False).count(),
            "url": reverse("admin:writing_writingcontent_changelist") + "?is_published__exact=0",
        })
    if _can(user, "feedback.view_feedback", "feedback.process_feedback"):
        cards.append({
            "title": "待处理反馈",
            "count": Feedback.objects.filter(status="pending").count(),
            "url": reverse("admin:feedback_feedback_changelist") + "?status__exact=pending",
        })
    if user.has_perm("payments.view_paymenttask"):
        cards.append({
            "title": "失败支付任务",
            "count": PaymentTask.objects.filter(status="failed").count(),
            "url": reverse("admin:payments_paymenttask_changelist") + "?status__exact=failed",
        })
    if user.has_perm("payments.view_order"):
        cards.append({
            "title": "待领取激活码",
            "count": Order.objects.filter(status="code_pending", agent_attribution__isnull=False).count(),
            "url": reverse("admin:payments_order_changelist") + "?status__exact=code_pending",
        })

    shortcuts = (
        ("导入题库", "admin:content_question_import", ("content.import_question",)),
        ("管理题目", "admin:content_question_changelist", ("content.view_question",)),
        ("管理应用文", "admin:writing_writingcontent_changelist", ("writing.view_writingcontent",)),
        ("查找学员", "admin:accounts_studentaccount_changelist", ("accounts.view_studentaccount", "accounts.set_student_status")),
        ("查看订单", "admin:payments_order_changelist", ("payments.view_order",)),
        ("处理反馈", "admin:feedback_feedback_changelist", ("feedback.view_feedback", "feedback.process_feedback")),
        ("代理激活明细", "admin:activation_activationredemption_changelist", ("distribution.view_agentperformance",)),
    )
    for title, route, permissions in shortcuts:
        if _can(user, *permissions):
            if route == "admin:activation_activationredemption_changelist" and is_agent_account(user):
                try:
                    AgentProfile.objects.only("pk").get(user=user)
                except AgentProfile.DoesNotExist:
                    if not user.has_perm("distribution.manage_agentprofile"):
                        continue
            links.append({"title": title, "url": reverse(route)})

    context["workbench_cards"] = cards
    context["workbench_links"] = links
    return context
