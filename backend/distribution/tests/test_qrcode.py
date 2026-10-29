from unittest.mock import patch
import json

from django.contrib.auth import get_user_model
from django.contrib.auth.models import Permission
from django.test import TestCase, override_settings

from common.errors import BusinessError
from distribution.models import AgentProfile
from distribution.services import generate_agent_qr


class FakeResponse:
    def __init__(self, content):
        self.content = content
        self.headers = {"Content-Type": "image/jpeg"}

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self, _limit):
        return self.content


@override_settings(AGENT_QRCODE_ENABLED=True)
class AgentQrTests(TestCase):
    def setUp(self):
        self.actor = get_user_model().objects.create_user(username="qr-manager", is_staff=True)
        permission = Permission.objects.get(
            content_type__app_label="distribution",
            codename="qrcode_agentprofile",
        )
        self.actor.user_permissions.add(permission)
        self.profile = AgentProfile(
            user=get_user_model().objects.create_user(username="qr-agent"),
            agent_code="QR001",
            display_name="二维码测试代理",
            created_by=self.actor,
        )
        self.profile.save(_service=True)

    @patch("payments.gateway.access_token", return_value="token")
    @patch("distribution.services.urlopen")
    def test_accepts_wechat_jpeg_qr(self, mocked_urlopen, _access_token):
        mocked_urlopen.return_value = FakeResponse(b"\xff\xd8\xff" + b"jpeg")

        result = generate_agent_qr(self.actor, self.profile.pk)

        self.assertTrue(result.qr_image.name.endswith(".jpg"))
        self.assertEqual(result.qr_image.read(), b"\xff\xd8\xffjpeg")
        request = mocked_urlopen.call_args.args[0]
        self.assertEqual(json.loads(request.data)["env_version"], "release")

    @patch("payments.gateway.access_token", return_value="token")
    @patch("distribution.services.urlopen")
    def test_rejects_non_image_response(self, mocked_urlopen, _access_token):
        mocked_urlopen.return_value = FakeResponse(b'{"errcode":41030}')

        with self.assertRaises(BusinessError) as error:
            generate_agent_qr(self.actor, self.profile.pk)
        self.assertEqual(str(error.exception.detail["error"]["code"]), "AGENT_QRCODE_FAILED")
