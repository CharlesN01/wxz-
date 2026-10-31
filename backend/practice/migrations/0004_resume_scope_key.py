from django.conf import settings
from django.db import migrations, models


def populate_scope_keys(apps, schema_editor):
    ResumePosition = apps.get_model("practice", "ResumePosition")
    for position in ResumePosition.objects.all().iterator():
        key = ":".join(str(value or "") for value in (
            "sequence", position.source, position.category_id,
            position.article_id, position.question_type,
        ))
        ResumePosition.objects.filter(pk=position.pk).update(scope_key=key)


class Migration(migrations.Migration):
    dependencies = [("practice", "0003_admin_chinese_labels")]

    operations = [
        migrations.AlterField(
            model_name="resumeposition",
            name="user",
            field=models.ForeignKey(
                on_delete=models.deletion.PROTECT,
                related_name="resume_positions",
                to=settings.AUTH_USER_MODEL,
                verbose_name="学员",
            ),
        ),
        migrations.AddField(
            model_name="resumeposition",
            name="scope_key",
            field=models.CharField(default="", editable=False, max_length=220, verbose_name="续学范围键"),
        ),
        migrations.RunPython(populate_scope_keys, migrations.RunPython.noop),
        migrations.AddConstraint(
            model_name="resumeposition",
            constraint=models.UniqueConstraint(fields=("user", "scope_key"), name="practice_resume_user_scope_unique"),
        ),
    ]
