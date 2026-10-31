from django.db import migrations, models


def migrate_resume_keys(apps, schema_editor):
    ResumePosition = apps.get_model("practice", "ResumePosition")
    for position in ResumePosition.objects.all().iterator():
        ResumePosition.objects.filter(pk=position.pk).update(
            scope_key=":".join(str(value or "") for value in (
                position.position_kind or "sequence", position.source, position.category_id,
                position.article_id, position.question_type,
            )),
        )


class Migration(migrations.Migration):
    dependencies = [("practice", "0004_resume_scope_key")]

    operations = [
        migrations.AddField(
            model_name="resumeposition",
            name="position_kind",
            field=models.CharField(
                choices=[("sequence", "顺序练习"), ("random", "随机练习")],
                default="sequence", max_length=12, verbose_name="板块类型",
            ),
        ),
        migrations.AddField(
            model_name="resumeposition",
            name="scope_index",
            field=models.PositiveIntegerField(default=0, verbose_name="范围序号"),
        ),
        migrations.AddField(
            model_name="resumeposition",
            name="completed",
            field=models.BooleanField(default=False, verbose_name="已完成"),
        ),
        migrations.RunPython(migrate_resume_keys, migrations.RunPython.noop),
        migrations.AddConstraint(
            model_name="resumeposition",
            constraint=models.CheckConstraint(
                condition=models.Q(position_kind__in=("sequence", "random")),
                name="practice_resume_position_kind",
            ),
        ),
        migrations.AddConstraint(
            model_name="resumeposition",
            constraint=models.CheckConstraint(
                condition=models.Q(scope_index__gte=0),
                name="practice_resume_scope_index",
            ),
        ),
    ]
