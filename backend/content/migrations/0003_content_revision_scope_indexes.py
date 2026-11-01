from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("content", "0002_learningconfiguration")]

    operations = [
        migrations.SeparateDatabaseAndState(
            # The application role may not own the restored PostgreSQL tables.
            # Deployment creates these indexes with the database owner, then
            # this migration records the model state without requiring DDL.
            database_operations=[],
            state_operations=[
                migrations.AddIndex(
                    model_name="questionrevision",
                    index=models.Index(fields=("article", "type", "sort_order", "question"), name="content_rev_article_type_idx"),
                ),
                migrations.AddIndex(
                    model_name="questionrevision",
                    index=models.Index(fields=("category", "type", "sort_order", "question"), name="content_rev_category_type_idx"),
                ),
            ],
        ),
    ]
