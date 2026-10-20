from django.urls import reverse_lazy


GROUPS = (
    ("题库内容", "menu_book", (
        ("文学分类", "content", "category", "view_category"),
        ("文言篇目", "content", "article", "view_article"),
        ("题目管理", "content", "question", "view_question"),
        ("题目修订记录", "content", "questionrevision", "view_questionrevision"),
        ("学习配置", "content", "learningconfiguration", "view_learningconfiguration"),
    )),
    ("应用文", "edit_note", (
        ("应用文分类", "writing", "writingcategory", "view_writingcategory"),
        ("应用文体裁", "writing", "writinggenre", "view_writinggenre"),
        ("应用文内容", "writing", "writingcontent", "view_writingcontent"),
        ("发布修订记录", "writing", "writingrevision", "view_writingrevision"),
    )),
    ("商品与权益", "card_membership", (
        ("全题库商品", "entitlements", "product", "view_product"),
        ("支付开通占位", "entitlements", "openingreservation", "view_openingreservation"),
        ("永久权益来源", "entitlements", "entitlementsource", "view_entitlementsource"),
        ("权益业务审计", "entitlements", "auditevent", "view_auditevent"),
    )),
    ("学员与学习", "school", (
        ("学员账号", "accounts", "studentaccount", "view_studentaccount"),
        ("微信身份", "accounts", "wechatidentity", "view_wechatidentity"),
        ("学员会话", "accounts", "studentsession", "view_studentsession"),
        ("学习偏好", "learning", "learningpreference", "view_learningpreference"),
        ("学习活动", "learning", "learningactivity", "view_learningactivity"),
        ("学习状态", "learning", "questionstate", "view_questionstate"),
        ("随机练习轮次", "practice", "practiceround", "view_practiceround"),
        ("练习题组", "practice", "rounditem", "view_rounditem"),
        ("继续学习位置", "practice", "resumeposition", "view_resumeposition"),
    )),
    ("订单与支付", "payments", (
        ("订单", "payments", "order", "view_order"),
        ("支付处理任务", "payments", "paymenttask", "view_paymenttask"),
        ("支付通知记录", "payments", "paymentevent", "view_paymentevent"),
    )),
    ("激活码", "confirmation_number", (
        ("激活码批次", "activation", "activationbatch", "view_activationbatch"),
        ("激活码记录", "activation", "activationcode", "view_activationcode"),
        ("兑换历史", "activation", "activationredemption", "view_activationredemption"),
    )),
    ("代理分销", "groups", (
        ("代理资料", "distribution", "agentprofile", "view_agentprofile"),
        ("订单代理归因", "distribution", "agentorderattribution", "view_agentorderattribution"),
        ("代理订单激活码", "distribution", "agentvoucher", "view_agentvoucher"),
        ("代理激活明细导出", "activation", "activationredemption", "view_activationredemption", "activation_redemption_export_agent", "distribution.export_agentperformance"),
    )),
    ("运营管理", "settings", (
        ("资料群配置", "resources", "groupresourceconfiguration", "view_groupresourceconfiguration"),
        ("用户反馈", "feedback", "feedback", "view_feedback"),
        ("后台账号", "accounts", "user", "view_user"),
        ("权限组", "auth", "group", "view_group"),
        ("后台操作日志", "admin", "logentry", "view_logentry"),
    )),
)


def navigation(request):
    user = request.user
    groups = []
    for title, icon, entries in GROUPS:
        items = []
        for entry in entries:
            label, app, model, permission, *extras = entry
            permission_name = extras[1] if len(extras) > 1 else f"{app}.{permission}"
            if user.has_perm(permission_name):
                route = extras[0] if extras else f"{app}_{model}_changelist"
                items.append({"title": label, "link": reverse_lazy(f"admin:{route}")})
        if items:
            groups.append({"title": title, "icon": icon, "collapsible": True, "items": items})
    return groups
