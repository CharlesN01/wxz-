from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    dependencies = [
        ("activation", "0003_admin_chinese_labels"),
        ("distribution", "0003_agent_wechat_qr"),
    ]

    operations = [
        migrations.AddField(
            model_name="activationredemption",
            name="attributed_agent",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.PROTECT,
                related_name="activation_redemptions",
                to="distribution.agentprofile",
                verbose_name="兑换业绩归属代理",
            ),
        ),
        migrations.AddIndex(
            model_name="activationredemption",
            index=models.Index(fields=("attributed_agent", "-redeemed_at"), name="activation_red_agent_time_idx"),
        ),
    ]
