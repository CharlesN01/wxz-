import django.core.validators
import distribution.qr
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("distribution", "0002_admin_chinese_labels"),
    ]

    operations = [
        migrations.AddField(
            model_name="agentprofile",
            name="agent_wechat_qr",
            field=models.FileField(
                blank=True,
                storage=distribution.qr.PublicAgentWechatQRStorage(),
                upload_to=distribution.qr.agent_wechat_qr_upload_to,
                validators=[
                    django.core.validators.FileExtensionValidator(
                        allowed_extensions=("png", "jpg", "jpeg", "webp")
                    ),
                    distribution.qr.validate_agent_wechat_qr,
                ],
                verbose_name="代理微信二维码",
            ),
        ),
        migrations.AlterModelOptions(
            name="agentprofile",
            options={
                "ordering": ("-created_at", "id"),
                "permissions": (
                    ("manage_agentprofile", "可以创建和管理代理"),
                    ("qrcode_agentprofile", "可以生成和下载代理二维码"),
                    ("upload_agentwechatqr_agentprofile", "可以上传代理微信二维码"),
                ),
                "verbose_name": "代理资料",
                "verbose_name_plural": "代理资料",
            },
        ),
    ]
