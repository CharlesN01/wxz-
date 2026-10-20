from django.contrib import admin
from django.contrib.auth.admin import UserAdmin as BaseUserAdmin, GroupAdmin as BaseGroupAdmin
from django.contrib.auth.models import Group
from django.contrib.admin.models import LogEntry
from django.core.paginator import Paginator
from django.core.exceptions import PermissionDenied
from django.db.models import Count, Q
from django.utils import timezone
from unfold.admin import ModelAdmin
from unfold.forms import AdminPasswordChangeForm, UserChangeForm, UserCreationForm

from .models import StudentAccount, StudentSession, User, WeChatIdentity


@admin.register(User)
class UserAdmin(BaseUserAdmin, ModelAdmin):
    form = UserChangeForm
    add_form = UserCreationForm
    change_password_form = AdminPasswordChangeForm


admin.site.unregister(Group)


@admin.register(Group)
class GroupAdmin(BaseGroupAdmin, ModelAdmin):
    pass


@admin.register(LogEntry)
class AuditLogAdmin(ModelAdmin):
    list_display = ("action_time", "user", "content_type", "object_repr", "action_flag", "change_message")
    list_filter = ("action_flag", "content_type")
    search_fields = ("object_repr", "change_message", "user__username")
    date_hierarchy = "action_time"
    readonly_fields = (
        "action_time", "user", "content_type", "object_id", "object_repr", "action_flag", "change_message",
    )

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


class ReadonlyIdentityAdmin(ModelAdmin):
    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


@admin.register(WeChatIdentity)
class WeChatIdentityAdmin(ReadonlyIdentityAdmin):
    list_display = ("id", "user", "app_id", "masked_openid", "updated_at")
    list_select_related = ("user",)
    search_fields = ("user__username",)
    readonly_fields = ("user", "app_id", "masked_openid", "created_at", "updated_at")
    fields = readonly_fields

    @admin.display(description="微信身份（脱敏）")
    def masked_openid(self, obj):
        return obj.openid[:4] + "…" + obj.openid[-4:] if len(obj.openid) > 8 else "已关联"


@admin.register(StudentSession)
class StudentSessionAdmin(ReadonlyIdentityAdmin):
    list_display = ("id", "user", "created_at", "expires_at", "revoked_at")
    list_select_related = ("user",)
    list_filter = ("revoked_at",)
    readonly_fields = ("user", "created_at", "expires_at", "revoked_at")
    fields = readonly_fields


@admin.register(StudentAccount)
class StudentAccountAdmin(ReadonlyIdentityAdmin):
    list_display = ('id','username','is_active','date_joined','profile_link','status_links')
    readonly_fields = list_display
    fields = list_display
    list_filter = ('is_active',)
    search_fields = ('username',)

    def get_queryset(self,request):
        return super().get_queryset(request).filter(is_staff=False,is_superuser=False,wechat_identities__isnull=False).distinct()

    def has_view_permission(self,request,obj=None):
        return request.user.has_perm('accounts.view_studentaccount') or request.user.has_perm('accounts.set_student_status')

    @admin.display(description='学员档案')
    def profile_link(self, obj):
        from django.urls import reverse
        from django.utils.html import format_html
        return format_html('<a href="{}">查看档案</a>', reverse('admin:accounts_studentaccount_profile', args=(obj.pk,)))

    @admin.display(description='启停操作')
    def status_links(self,obj):
        from django.urls import reverse
        from django.utils.html import format_html
        action='disable' if obj.is_active else 'enable'
        return format_html('<a href="{}">{}</a>',reverse('admin:student_status',args=(obj.pk,action)), '停用学员' if obj.is_active else '启用学员')

    def get_list_display(self, request):
        fields = super().get_list_display(request)
        if not request.user.has_perm('accounts.set_student_status'):
            return tuple(field for field in fields if field != 'status_links')
        return fields

    def get_fields(self, request, obj=None):
        fields = super().get_fields(request, obj)
        if not request.user.has_perm('accounts.set_student_status'):
            return [field for field in fields if field != 'status_links']
        return fields

    def get_urls(self):
        from django.urls import path
        return [
            path('<int:user_id>/profile/', self.admin_site.admin_view(self.profile_view), name='accounts_studentaccount_profile'),
            path('<int:user_id>/records/<str:record_type>/', self.admin_site.admin_view(self.records_view), name='accounts_studentaccount_records'),
            path('<int:user_id>/status/<str:action>/',self.admin_site.admin_view(self.status_view),name='student_status'),
        ]+super().get_urls()

    def get_student_for_request(self, request, user_id):
        from django.shortcuts import get_object_or_404
        if not self.has_view_permission(request):
            raise PermissionDenied
        return get_object_or_404(self.get_queryset(request), pk=user_id)

    def profile_view(self, request, user_id):
        from django.template.response import TemplateResponse
        from django.urls import reverse
        from accounts.models import StudentSession
        from entitlements.models import EntitlementSource
        from learning.models import LearningActivity, LearningPreference, QuestionState
        from payments.models import Order

        if request.method != 'GET':
            raise PermissionDenied
        student = self.get_student_for_request(request, user_id)
        now = timezone.now()
        identity = student.wechat_identities.order_by('-updated_at').first()
        openid = identity.openid if identity else ''
        masked_openid = openid[:4] + '…' + openid[-4:] if len(openid) > 8 else ('已关联' if openid else '未关联')
        state_counts = QuestionState.objects.filter(user=student).aggregate(
            total=Count('pk'), favorites=Count('pk', filter=Q(favorite=True)), mastered=Count('pk', filter=Q(mastered=True)),
        )
        activities = list(LearningActivity.objects.filter(user=student).order_by('-created_at', '-pk').values(
            'question_id', 'study_date', 'created_at',
        )[:20])
        sources = list(EntitlementSource.objects.filter(user=student).order_by('-created_at').values(
            'source_type', 'source_id', 'status', 'created_at', 'revoked_at',
        )[:20])
        orders = list(Order.objects.filter(user=student).order_by('-created_at').values(
            'id', 'product_name', 'price_fen', 'channel', 'status', 'created_at', 'paid_at',
        )[:20])
        context = {
            **self.admin_site.each_context(request), 'opts': self.model._meta,
            'title': f'学员档案：{student.username}', 'student': student,
            'masked_openid': masked_openid, 'wechat_app_id': identity.app_id if identity else '',
            'active_session_count': StudentSession.objects.filter(user=student, revoked_at__isnull=True, expires_at__gt=now).count(),
            'preference': LearningPreference.objects.filter(user=student).first(),
            'state_counts': state_counts, 'activities': activities, 'sources': sources, 'orders': orders,
            'activities_url': reverse_admin_records(student.pk, 'activities'),
            'states_url': reverse_admin_records(student.pk, 'states'),
            'sources_url': reverse_admin_records(student.pk, 'sources'),
            'orders_url': reverse_admin_records(student.pk, 'orders'),
            'changelist_url': reverse('admin:accounts_studentaccount_changelist'),
        }
        return TemplateResponse(request, 'admin/accounts/student_profile.html', context)

    def records_view(self, request, user_id, record_type):
        from django.template.response import TemplateResponse
        from entitlements.models import EntitlementSource
        from learning.models import LearningActivity, QuestionState
        from payments.models import Order

        if request.method != 'GET':
            raise PermissionDenied
        student = self.get_student_for_request(request, user_id)
        records = {
            'activities': (LearningActivity.objects.filter(user=student).order_by('-created_at', '-pk').values('question_id', 'study_date', 'created_at'), '学习活动'),
            'states': (QuestionState.objects.filter(user=student).order_by('-updated_at', '-pk').values('question_id', 'favorite', 'mastered', 'version', 'updated_at'), '收藏与掌握状态'),
            'sources': (EntitlementSource.objects.filter(user=student).order_by('-created_at', '-pk').values('source_type', 'source_id', 'status', 'created_at', 'revoked_at'), '权益来源'),
            'orders': (Order.objects.filter(user=student).order_by('-created_at', '-pk').values('id', 'product_name', 'price_fen', 'channel', 'status', 'created_at', 'paid_at'), '订单'),
        }
        if record_type not in records:
            raise PermissionDenied
        queryset, title = records[record_type]
        page = Paginator(queryset, 50).get_page(request.GET.get('page'))
        return TemplateResponse(request, 'admin/accounts/student_records.html', {
            **self.admin_site.each_context(request), 'opts': self.model._meta,
            'title': f'{student.username} · {title}', 'student': student,
            'record_type': record_type, 'page_obj': page,
            'back_url': reverse_admin_records(student.pk, 'profile'),
        })

    def status_view(self,request,user_id,action):
        from django.core import signing
        from django.core.exceptions import PermissionDenied
        from django.http import HttpResponseRedirect
        from django.shortcuts import get_object_or_404
        from django.template.response import TemplateResponse
        from django.urls import reverse
        from common.errors import BusinessError
        from .student_admin_services import set_student_status,student_status_fingerprint
        if not request.user.has_perm('accounts.set_student_status'):
            raise PermissionDenied
        if action not in ('enable','disable'):
            raise PermissionDenied
        user=get_object_or_404(self.get_queryset(request),pk=user_id)
        salt='accounts.student-status.v1'
        fingerprint=student_status_fingerprint(user)
        expected={'actor':request.user.pk,'user':user_id,'action':action,'fingerprint':fingerprint}
        error_message=''; status=200
        if request.method=='POST':
            try:
                if set(request.POST)-{'csrfmiddlewaretoken','confirmation_token','reason','confirm'}:
                    raise BusinessError('INVALID_STATUS_REQUEST','请求字段无效。')
                payload=signing.loads(request.POST.get('confirmation_token',''),salt=salt,max_age=1800)
                if payload!=expected or request.POST.get('confirm')!='yes':
                    raise BusinessError('VERSION_CONFLICT','确认凭证不匹配，请重新预览。',409)
                set_student_status(user_id,request.user,enabled=action=='enable',reason=request.POST.get('reason',''),expected_fingerprint=payload['fingerprint'])
                return HttpResponseRedirect(reverse('admin:accounts_studentaccount_changelist'))
            except signing.BadSignature:
                error_message='确认凭证已过期或无效，请重新预览。'; status=409
            except BusinessError as error:
                error_message=str(error.detail['error']['message']); status=error.status_code
        elif request.method!='GET':
            raise PermissionDenied
        return TemplateResponse(request,'admin/accounts/student_status.html',{
            **self.admin_site.each_context(request),'title':'学员启停确认','opts':self.model._meta,
            'target_user':user,'action':action,'confirmation_token':signing.dumps(expected,salt=salt),
            'error_message':error_message,'active_session_count':user.student_sessions.filter(revoked_at__isnull=True,expires_at__gt=timezone.now()).count(),
        },status=status)


def reverse_admin_records(user_id, record_type):
    from django.urls import reverse
    if record_type == 'profile':
        return reverse('admin:accounts_studentaccount_profile', args=(user_id,))
    return reverse('admin:accounts_studentaccount_records', args=(user_id, record_type))
