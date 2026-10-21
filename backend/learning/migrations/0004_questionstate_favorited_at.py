from itertools import groupby

from django.db import migrations, models


def restore_favorite_times(apps, schema_editor):
    """Recover only a fully evidenced current favorite transition, never updated_at."""
    State = apps.get_model("learning", "QuestionState")
    Record = apps.get_model("common", "IdempotencyRecord")
    alias = schema_editor.connection.alias
    states = State.objects.using(alias).filter(favorite=True, favorited_at__isnull=True).order_by("user_id", "pk")
    for user_id, group in groupby(states.iterator(), key=lambda state: state.user_id):
        owned = {str(state.question_id): state for state in group}
        history = {question_id: {} for question_id in owned}
        records = Record.objects.using(alias).filter(user_id=user_id, operation="learning-question-state")
        for record in records.iterator():
            value = record.response
            if not isinstance(value, dict):
                continue
            question_id, version = value.get("questionId"), value.get("version")
            if question_id in history and type(version) is int and type(value.get("favorite")) is bool:
                history[question_id][version] = (value["favorite"], record.created_at)
        recovered = []
        for question_id, state in owned.items():
            version, candidate = state.version, None
            while version > 0:
                entry = history[question_id].get(version)
                if entry is None:
                    candidate = None
                    break
                if not entry[0]:
                    break
                candidate = entry[1]
                version -= 1
            if candidate is not None:
                state.favorited_at = candidate
                recovered.append(state)
        if recovered:
            State.objects.using(alias).bulk_update(recovered, ["favorited_at"], batch_size=500)


class Migration(migrations.Migration):
    dependencies = [("learning", "0003_admin_chinese_labels"), ("common", "0001_initial")]
    operations = [
        migrations.AddField(
            model_name="questionstate", name="favorited_at",
            field=models.DateTimeField("本次收藏时间", null=True, blank=True),
        ),
        migrations.RunPython(restore_favorite_times, migrations.RunPython.noop),
    ]
