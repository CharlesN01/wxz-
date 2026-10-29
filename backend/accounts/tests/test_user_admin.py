from django.contrib.auth import get_user_model
from django.test import TestCase
from django.urls import reverse


class UserAdminCreationTests(TestCase):
    def setUp(self):
        self.admin = get_user_model().objects.create_superuser(
            username="user-creator", password="admin-test-password"
        )
        self.client.force_login(self.admin)

    def test_new_user_is_saved_as_regular_staff_and_can_log_in(self):
        response = self.client.post(reverse("admin:accounts_user_add"), {
            "username": "new-backend-user",
            "password1": "regular-test-password",
            "password2": "regular-test-password",
        })

        self.assertEqual(response.status_code, 302)
        user = get_user_model().objects.get(username="new-backend-user")
        self.assertTrue(user.is_active)
        self.assertTrue(user.is_staff)
        self.assertFalse(user.is_superuser)
        self.assertTrue(user.check_password("regular-test-password"))

        self.client.logout()
        self.assertTrue(self.client.login(
            username="new-backend-user", password="regular-test-password"
        ))

