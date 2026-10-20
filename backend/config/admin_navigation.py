from django.urls import reverse_lazy


AGENT_VIEW_PERMISSIONS = (
    "distribution.view_agentprofile",
    "distribution.view_agentorderattribution",
    "distribution.view_agentvoucher",
    "distribution.view_agentperformance",
    "distribution.export_agentperformance",
    "activation.view_activationredemption",
)


GROUPS = (
    ("工作台", "dashboard", (("工作台", "admin:index", "staff"),)),
    ("内容管理", "menu_book", (
        ("题目管理", "admin:content_question_changelist", "content.view_question"),
        ("题库导入", "admin:content_question_import", "content.import_question"),
        ("文言篇目", "admin:content_article_changelist", "content.view_article"),
        ("文学分类", "admin:content_category_changelist", "content.view_category"),
        ("应用文内容", "admin:writing_writingcontent_changelist", "writing.view_writingcontent"),
        ("应用文导入", "admin:writing_writingcontent_import", "writing_import"),
        ("应用文分类", "admin:writing_writingcategory_changelist", "writing.view_writingcategory"),
        ("应用文体裁", "admin:writing_writinggenre_changelist", "writing.view_writinggenre"),
    )),
    ("学员服务", "school", (
        ("学员账号", "admin:accounts_studentaccount_changelist", ("accounts.view_studentaccount", "accounts.set_student_status")),
    )),
    ("商品与交易", "shopping_cart", (
        ("全题库商品", "admin:entitlements_product_changelist", "entitlements.view_product"),
        ("订单", "admin:payments_order_changelist", "payments.view_order"),
    )),
    ("激活码与代理", "confirmation_number", (
        ("激活码批次", "admin:activation_activationbatch_changelist", "activation.view_activationbatch"),
        ("激活码记录", "admin:activation_activationcode_changelist", "activation.view_activationcode"),
        ("兑换历史", "admin:activation_activationredemption_changelist", "activation.view_activationredemption"),
        ("代理资料", "admin:distribution_agentprofile_changelist", "distribution.view_agentprofile"),
        ("代理订单激活码", "admin:distribution_agentvoucher_changelist", "distribution.view_agentvoucher"),
        ("代理激活明细导出", "admin:activation_redemption_export_agent", "distribution.export_agentperformance"),
    )),
    ("运营与系统", "settings", (
        ("考试倒计时与学习配置", "admin:content_learningconfiguration_changelist", ("content.view_learningconfiguration", "content.change_learningconfiguration")),
        ("资料群配置", "admin:resources_groupresourceconfiguration_changelist", "resources.view_groupresourceconfiguration"),
        ("用户反馈", "admin:feedback_feedback_changelist", ("feedback.view_feedback", "feedback.process_feedback")),
        ("后台账号", "admin:accounts_user_changelist", "accounts.view_user"),
        ("权限组", "admin:auth_group_changelist", "auth.view_group"),
        ("后台操作日志", "admin:admin_logentry_changelist", "admin.view_logentry"),
    )),
    ("高级记录", "manage_search", (
        ("题目修订记录", "admin:content_questionrevision_changelist", "content.view_questionrevision"),
        ("应用文发布修订", "admin:writing_writingrevision_changelist", "writing.view_writingrevision"),
        ("学员微信身份", "admin:accounts_wechatidentity_changelist", "accounts.view_wechatidentity"),
        ("学员会话", "admin:accounts_studentsession_changelist", "accounts.view_studentsession"),
        ("学习偏好", "admin:learning_learningpreference_changelist", "learning.view_learningpreference"),
        ("学习活动", "admin:learning_learningactivity_changelist", "learning.view_learningactivity"),
        ("学习状态", "admin:learning_questionstate_changelist", "learning.view_questionstate"),
        ("随机练习轮次", "admin:practice_practiceround_changelist", "practice.view_practiceround"),
        ("练习题组", "admin:practice_rounditem_changelist", "practice.view_rounditem"),
        ("继续学习位置", "admin:practice_resumeposition_changelist", "practice.view_resumeposition"),
        ("支付处理任务", "admin:payments_paymenttask_changelist", "payments.view_paymenttask"),
        ("支付通知记录", "admin:payments_paymentevent_changelist", "payments.view_paymentevent"),
        ("支付开通占位", "admin:entitlements_openingreservation_changelist", "entitlements.view_openingreservation"),
        ("永久权益来源", "admin:entitlements_entitlementsource_changelist", "entitlements.view_entitlementsource"),
        ("权益业务审计", "admin:entitlements_auditevent_changelist", "entitlements.view_auditevent"),
        ("订单代理归因", "admin:distribution_agentorderattribution_changelist", "distribution.view_agentorderattribution"),
    )),
)


def is_agent_account(user):
    return (
        all(user.has_perm(permission) for permission in AGENT_VIEW_PERMISSIONS)
        and not user.has_perm("distribution.manage_agentprofile")
    )


def navigation(request):
    user = request.user
    groups = []
    agent_account = is_agent_account(user)
    agent_bound = not agent_account or hasattr(user, "agent_profile")

    for title, icon, entries in GROUPS:
        items = []
        for label, route, permission in entries:
            if permission == "writing_import":
                from writing.import_services import has_import_permission

                allowed = has_import_permission(user)
            elif permission == "staff":
                allowed = user.is_staff
            elif isinstance(permission, tuple):
                allowed = any(user.has_perm(value) for value in permission)
            else:
                allowed = user.has_perm(permission)

            if not allowed:
                continue
            if title == "激活码与代理" and (
                route.startswith(("admin:distribution_", "admin:activation_activationredemption_"))
                or route == "admin:activation_redemption_export_agent"
            ):
                if not agent_bound:
                    continue
            items.append({"title": label, "link": reverse_lazy(route)})

        if items:
            groups.append({
                "title": title,
                "icon": icon,
                "collapsible": True,
                "items": items,
            })
    return groups
