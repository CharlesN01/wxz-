from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("practice", "0001_initial"),
    ]

    operations = [
        migrations.RemoveConstraint(
            model_name="practiceround",
            name="practice_round_scope",
        ),
        migrations.AddConstraint(
            model_name="practiceround",
            constraint=models.CheckConstraint(
                condition=(
                    models.Q(source="literature", article__isnull=True, question_type__in=("", "fact"))
                    | models.Q(source="classical", category__isnull=True,
                               question_type__in=("", "fact", "word", "translation"))
                ),
                name="practice_round_scope",
            ),
        ),
        migrations.RemoveConstraint(
            model_name="resumeposition",
            name="practice_resume_scope",
        ),
        migrations.AddConstraint(
            model_name="resumeposition",
            constraint=models.CheckConstraint(
                condition=(
                    models.Q(source="literature", article__isnull=True, question_type__in=("", "fact"))
                    | models.Q(source="classical", category__isnull=True,
                               question_type__in=("", "fact", "word", "translation"))
                ),
                name="practice_resume_scope",
            ),
        ),
    ]
