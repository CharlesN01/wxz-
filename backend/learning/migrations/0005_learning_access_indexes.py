from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("learning", "0004_questionstate_favorited_at")]

    operations = [
        migrations.SeparateDatabaseAndState(
            # See content.0003: DDL is applied by the database owner during
            # deployment so the app role never needs schema privileges.
            database_operations=[],
            state_operations=[
                migrations.AddIndex(
                    model_name="questionstate",
                    index=models.Index(fields=("user", "mastered", "question"), name="learn_state_user_mastered_idx"),
                ),
                migrations.AddIndex(
                    model_name="learningactivity",
                    index=models.Index(fields=("user", "study_date"), name="learn_activity_user_date_idx"),
                ),
            ],
        ),
    ]
