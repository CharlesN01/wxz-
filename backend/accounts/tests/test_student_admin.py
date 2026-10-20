from cryptography.fernet import Fernet
from django.contrib.auth.models import Permission
from django.core import signing
from django.test import Client, TestCase, override_settings
from django.urls import reverse

from accounts.models import StudentSession, User, WeChatIdentity
from accounts.services import issue_student_session
from accounts.student_admin_services import set_student_status, student_status_fingerprint
from accounts.wechat import WeChatLogin
from common.errors import BusinessError
from entitlements.models import AuditEvent


@override_settings(STUDENT_SESSION_ENCRYPTION_KEYS=(Fernet.generate_key().decode(),))
class StudentStatusAdminTests(TestCase):
    def setUp(self):
        self.actor = User.objects.create_user('student-operator', password='test-password', is_staff=True)
        self.actor.user_permissions.set(Permission.objects.filter(
            content_type__app_label='accounts',
            codename__in=('view_studentaccount', 'set_student_status'),
        ))
        self.login = WeChatLogin('test-app', 'test-student', 'dGVzdC1kZXZpY2Uta2V5')
        self.token, self.session = issue_student_session(self.login)
        issue_student_session(self.login)
        self.user = self.session.user
        self.client.force_login(self.actor)

    def test_student_profile_is_read_only_and_masks_identity(self):
        from django.utils import timezone
        from learning.models import LearningActivity, LearningPreference, QuestionState
        from content.models import Category, Question
        identity = WeChatIdentity.objects.get(user=self.user)
        identity.openid = 'openid-should-not-leak'
        identity.save()
        LearningPreference.objects.create(user=self.user, mode='reciting', daily_target=30)
        question = Question.objects.create(id='profile-question', source='literature', type='fact',
                                           category=Category.objects.create(id='profile-category', name='资料'),
                                           stem='测试{{0}}', answers=['答案'])
        QuestionState.objects.create(user=self.user, question=question, favorite=True, mastered=True)
        LearningActivity.objects.create(user=self.user, question=question, study_date=timezone.localdate())
        response = self.client.get(reverse('admin:accounts_studentaccount_profile', args=(self.user.pk,)))
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, 'open…leak')
        self.assertEqual(response.context['masked_openid'], 'open…leak')
        self.assertNotContains(response, identity.openid)
        self.assertContains(response, '查看该学员全部订单')
        self.assertNotContains(response, 'encrypted_session_key')
        self.assertNotContains(response, 'sign_data')
        self.assertEqual(self.client.post(reverse('admin:accounts_studentaccount_profile', args=(self.user.pk,))).status_code, 403)

    def test_student_list_has_profile_entry_and_hides_status_action_from_view_only_role(self):
        list_url = reverse('admin:accounts_studentaccount_changelist')
        response = self.client.get(list_url)
        self.assertContains(response, '查看档案')
        self.assertContains(response, reverse('admin:accounts_studentaccount_profile', args=(self.user.pk,)))
        viewer = User.objects.create_user('profile-list-viewer', password='test-password', is_staff=True)
        viewer.user_permissions.add(Permission.objects.get(content_type__app_label='accounts', codename='view_studentaccount'))
        self.client.force_login(viewer)
        response = self.client.get(list_url)
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, '查看档案')
        self.assertNotContains(response, '停用学员')

    def test_profile_recent_activity_is_capped_and_full_list_is_student_scoped(self):
        from django.utils import timezone
        from content.models import Category, Question
        from learning.models import LearningActivity
        category = Category.objects.create(id='activity-profile-category', name='资料')
        for index in range(21):
            question = Question.objects.create(id=f'activity-profile-{index}', source='literature', type='fact',
                                               category=category, stem='测试{{0}}', answers=['答案'])
            LearningActivity.objects.create(user=self.user, question=question, study_date=timezone.localdate())
        url = reverse('admin:accounts_studentaccount_profile', args=(self.user.pk,))
        profile = self.client.get(url)
        self.assertEqual(profile.status_code, 200)
        self.assertEqual(len(profile.context['activities']), 20)
        full_list = self.client.get(profile.context['activities_url'])
        self.assertEqual(full_list.status_code, 200)
        self.assertEqual(full_list.context['page_obj'].paginator.count, 21)

    def test_profile_requires_student_view_permission_and_non_student_is_hidden(self):
        viewer = User.objects.create_user('profile-viewer', password='test-password', is_staff=True)
        viewer.user_permissions.add(Permission.objects.get(content_type__app_label='accounts', codename='view_studentaccount'))
        self.client.force_login(viewer)
        self.assertEqual(self.client.get(reverse('admin:accounts_studentaccount_profile', args=(self.user.pk,))).status_code, 200)
        for target in (viewer, User.objects.create_user('unlinked-profile')):
            self.assertEqual(self.client.get(reverse('admin:accounts_studentaccount_profile', args=(target.pk,))).status_code, 404)

    def test_profile_lists_are_filtered_by_exact_student(self):
        from content.models import Category, Question
        from learning.models import QuestionState
        viewer = User.objects.create_user('records-viewer', password='test-password', is_staff=True)
        viewer.user_permissions.add(Permission.objects.get(content_type__app_label='accounts', codename='view_studentaccount'))
        self.client.force_login(viewer)
        other_login = WeChatLogin('test-app', 'other-profile-student', 'dGVzdC1kZXZpY2Uta2V5')
        _, other_session = issue_student_session(other_login)
        question = Question.objects.create(id='other-profile-question', source='literature', type='fact',
                                           category=Category.objects.create(id='other-profile-category', name='资料'),
                                           stem='测试{{0}}', answers=['答案'])
        QuestionState.objects.create(user=other_session.user, question=question, favorite=True)
        response = self.client.get(reverse('admin:accounts_studentaccount_records', args=(self.user.pk, 'states')))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.context['page_obj'].paginator.count, 0)
        self.assertNotContains(response, question.pk)

    def url(self, action='disable', user=None):
        return reverse('admin:student_status', args=((user or self.user).pk, action))

    def preview(self, action='disable'):
        response = self.client.get(self.url(action))
        self.assertEqual(response.status_code, 200)
        return response.context_data['confirmation_token']

    def post(self, token, action='disable', **extra):
        return self.client.post(self.url(action), {
            'confirmation_token': token, 'reason': '核对甲方停用申请', 'confirm': 'yes', **extra,
        })

    def test_limited_operator_cannot_edit_user_permissions_or_escalate(self):
        actor = User.objects.get(pk=self.actor.pk)
        self.assertFalse(actor.has_perm('accounts.change_user'))
        response = self.client.post(reverse('admin:accounts_user_change', args=(self.user.pk,)), {
            'is_superuser': 'on', 'is_staff': 'on',
        })
        self.assertEqual(response.status_code, 403)
        token = self.preview()
        self.assertEqual(self.post(token, is_superuser='on').status_code, 400)
        self.user.refresh_from_db()
        self.assertFalse(self.user.is_superuser)
        self.assertTrue(self.user.is_active)
        self.assertFalse(AuditEvent.objects.filter(kind='student_status_changed').exists())

    def test_disable_revokes_all_sessions_and_enable_requires_new_login(self):
        self.assertEqual(self.post(self.preview()).status_code, 302)
        self.user.refresh_from_db()
        self.assertFalse(self.user.is_active)
        self.assertFalse(StudentSession.objects.filter(user=self.user, revoked_at__isnull=True).exists())
        response = self.client.get('/api/student/v1/me/entitlements/', HTTP_AUTHORIZATION='Bearer ' + self.token)
        self.assertEqual(response.status_code, 401)
        self.assertEqual(self.post(self.preview('enable'), 'enable').status_code, 302)
        self.user.refresh_from_db()
        self.assertTrue(self.user.is_active)
        self.assertEqual(self.client.get('/api/student/v1/me/entitlements/', HTTP_AUTHORIZATION='Bearer ' + self.token).status_code, 401)
        new_token, _ = issue_student_session(self.login)
        self.assertEqual(self.client.get('/api/student/v1/me/entitlements/', HTTP_AUTHORIZATION='Bearer ' + new_token).status_code, 200)
        self.assertEqual(AuditEvent.objects.filter(kind='student_status_changed', actor=self.actor).count(), 2)

    def test_missing_permission_and_nonstudent_targets_are_refused(self):
        viewer = User.objects.create_user('viewer', is_staff=True)
        viewer.user_permissions.add(Permission.objects.get(content_type__app_label='accounts', codename='view_studentaccount'))
        self.client.force_login(viewer)
        self.assertEqual(self.client.get(self.url()).status_code, 403)
        self.client.force_login(self.actor)
        for target in (self.actor, User.objects.create_superuser('super', password='test-password'), User.objects.create_user('unlinked')):
            self.assertEqual(self.client.get(self.url(user=target)).status_code, 404)
            with self.assertRaises(BusinessError) as caught:
                set_student_status(target.pk, self.actor, enabled=False, reason='停用', expected_fingerprint=student_status_fingerprint(target))
            self.assertEqual(caught.exception.detail['error']['code'], 'FORBIDDEN')

    def test_signed_preview_is_bound_to_actor_action_and_current_state(self):
        token = self.preview()
        self.assertEqual(self.post(token, 'enable').status_code, 409)
        second = User.objects.create_user('second-operator', is_staff=True)
        second.user_permissions.set(self.actor.user_permissions.all())
        self.client.force_login(second)
        self.assertEqual(self.post(token).status_code, 409)
        self.client.force_login(self.actor)
        User.objects.filter(pk=self.user.pk).update(is_active=False)
        self.assertEqual(self.post(token).status_code, 409)
        self.assertFalse(AuditEvent.objects.filter(kind='student_status_changed').exists())

    def test_confirmation_reason_signature_and_csrf_are_required(self):
        token = self.preview()
        self.assertEqual(self.post(token, reason=' ').status_code, 400)
        self.assertEqual(self.post(token, confirm='').status_code, 409)
        self.assertEqual(self.post('invalid-signature').status_code, 409)
        forged = signing.dumps({'actor': self.actor.pk}, salt='accounts.student-status.v1')
        self.assertEqual(self.post(forged).status_code, 409)
        protected = Client(enforce_csrf_checks=True)
        protected.force_login(self.actor)
        self.assertEqual(protected.post(self.url(), {'confirmation_token': token, 'reason': '停用', 'confirm': 'yes'}).status_code, 403)
        self.user.refresh_from_db()
        self.assertTrue(self.user.is_active)

    def test_service_rechecks_permission_and_rejects_stale_preview(self):
        fingerprint = student_status_fingerprint(self.user)
        self.actor.user_permissions.clear()
        with self.assertRaises(BusinessError) as caught:
            set_student_status(self.user.pk, self.actor, enabled=False, reason='停用', expected_fingerprint=fingerprint)
        self.assertEqual(caught.exception.detail['error']['code'], 'FORBIDDEN')

    def test_old_preview_stays_invalid_after_disable_enable_cycle(self):
        old_disable = self.preview()
        self.assertEqual(self.post(old_disable).status_code, 302)
        old_enable = self.preview('enable')
        self.assertEqual(self.post(old_enable, 'enable').status_code, 302)
        self.assertEqual(self.post(old_disable).status_code, 409)
        self.assertEqual(self.post(self.preview()).status_code, 302)
        self.assertEqual(self.post(old_enable, 'enable').status_code, 409)
        self.assertEqual(AuditEvent.objects.filter(kind='student_status_changed').count(), 3)
