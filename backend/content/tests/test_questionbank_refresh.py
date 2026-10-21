import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.exceptions import PermissionDenied, ValidationError
from django.test import TestCase

from content.models import Category, Question, QuestionRevision
from content.questionbank_refresh import (
    apply_bundle, check_baseline, load_bundle, make_plan, read_state, restore_backup,
)
from content.services import publish_questions
from learning.models import QuestionState


class QuestionbankRefreshTests(TestCase):
    def setUp(self):
        self.actor = get_user_model().objects.create_superuser(username="refresh-owner", password="not-used")
        self.category = Category.objects.create(id="pre-qin", name="先秦文学")
        self.retained = self.question("stable", "《诗经》有{{0}}篇。", ["旧答案"])
        self.archived = self.question("old", "旧题{{0}}", ["保留历史"])
        publish_questions(Question.objects.all(), self.actor)
        self.before = read_state()
        rows = []
        for index, (qid, stem, answers) in enumerate((
            ("stable", "《诗经》有{{0}}篇。", ["305"]),
            ("qb-20261021-lit-1", "《山海经》是{{0}}。", ["古籍"]),
            ("qb-20261021-lit-2", "《论语》记载{{0}}。", ["孔子言行"]),
        )):
            rows.append({
                "id": qid, "source": "literature", "type": "fact", "tag": "文学常识",
                "category_id": self.category.pk, "article_id": None, "stem": stem,
                "answers": answers, "sort_order": index, "source_file": f"input-{index}.xlsx",
                "source_id": f"lit-{index}", "source_row": 2,
            })
        self.bundle = {
            "schema": "chinese-study-questionbank-v1", "scope_sources": ["literature", "classical"],
            "source_files": [{"name": f"input-{i}.xlsx", "sha256": "a" * 64, "count": 1} for i in range(3)],
            "questions": rows, "categories": self.before["categories"], "articles": [],
            "baseline_questions": self.before["questions"],
        }
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.backup = Path(self.tmp.name) / "rollback.json"

    def question(self, qid, stem, answers):
        return Question.objects.create(id=qid, source="literature", type="fact", category=self.category, stem=stem, answers=answers)

    def validated(self):
        return load_bundle(json.dumps(self.bundle))

    def apply(self):
        return apply_bundle(self.validated(), actor=self.actor, backup_path=self.backup)

    def test_default_plan_is_read_only_and_rejects_missing_source_rows(self):
        bundle = self.validated()
        plan = make_plan(bundle, read_state())
        check_baseline(bundle, read_state(), plan)
        self.assertEqual((len(plan["new"]), len(plan["updated"]), len(plan["archive"])), (2, 1, 1))
        self.assertEqual(read_state(), self.before)
        self.bundle["source_files"][0]["count"] = 2
        with self.assertRaisesMessage(ValidationError, "禁止漏行"):
            self.validated()

    def test_replacement_preserves_identity_and_revisions_and_is_idempotent(self):
        state = QuestionState.objects.create(user=self.actor, question=self.archived, favorite=True, mastered=True, version=7)
        original_revision = Question.objects.get(pk="stable").published_revision_id
        original_archived_revision = Question.objects.get(pk="old").published_revision_id
        self.apply()
        self.retained.refresh_from_db()
        self.archived.refresh_from_db()
        self.assertEqual(self.retained.answers, ["305"])
        self.assertNotEqual(self.retained.published_revision_id, original_revision)
        self.assertTrue(QuestionRevision.objects.filter(pk=original_revision).exists())
        self.assertFalse(self.archived.is_published)
        self.assertEqual(self.archived.published_revision_id, original_archived_revision)
        self.assertTrue(Question.objects.filter(pk="old").exists())
        state.refresh_from_db()
        self.assertEqual((state.question_id, state.favorite, state.mastered, state.version), ("old", True, True, 7))
        self.assertEqual(Question.objects.filter(is_published=True).count(), 3)
        count = QuestionRevision.objects.count()
        second = apply_bundle(self.validated(), actor=self.actor, backup_path=Path(self.tmp.name) / "unused.json")
        self.assertEqual((second["new"], second["updated"], second["archive"], second["publish"]), ([], [], [], []))
        self.assertEqual(QuestionRevision.objects.count(), count)

    def test_failure_during_publish_rolls_back_drafts_and_unpublish(self):
        with patch("content.questionbank_refresh.publish_questions", side_effect=ValidationError("failed publication")):
            with self.assertRaises(ValidationError):
                self.apply()
        self.assertEqual(read_state(), self.before)
        self.assertFalse(self.backup.exists())

    def test_backup_write_failure_rolls_back_the_entire_import(self):
        self.backup.write_text("keep", encoding="utf-8")
        with self.assertRaises(FileExistsError):
            self.apply()
        self.assertEqual(read_state(), self.before)
        self.assertEqual(self.backup.read_text(encoding="utf-8"), "keep")

    def test_changed_baseline_rejects_overwriting_new_manual_edits(self):
        Question.objects.filter(pk="stable").update(answers=["manual change"])
        with self.assertRaisesMessage(ValidationError, "生产快照不一致"):
            self.apply()
        self.assertFalse(self.backup.exists())
        self.assertEqual(Question.objects.count(), 2)

    def test_restore_keeps_new_rows_and_history_then_allows_repeat(self):
        self.apply()
        count = QuestionRevision.objects.count()
        backup = json.loads(self.backup.read_text(encoding="utf-8"))
        self.assertEqual(restore_backup(backup, actor=self.actor), 2)
        self.assertEqual(QuestionRevision.objects.count(), count)
        self.assertEqual(Question.objects.count(), 4)
        self.assertEqual(Question.objects.filter(is_published=True).count(), 2)
        self.retained.refresh_from_db()
        self.assertEqual(self.retained.answers, ["旧答案"])
        self.assertEqual(restore_backup(backup, actor=self.actor), 0)

    def test_restore_rejects_changes_after_import(self):
        self.apply()
        backup = json.loads(self.backup.read_text(encoding="utf-8"))
        Question.objects.filter(pk="stable").update(answers=["later edit"])
        with self.assertRaisesMessage(ValidationError, "已有人工修改"):
            restore_backup(backup, actor=self.actor)

    def test_same_bundle_can_be_reapplied_after_rollback_without_recreating_retained_rows(self):
        self.apply()
        backup = json.loads(self.backup.read_text(encoding="utf-8"))
        restore_backup(backup, actor=self.actor)
        plan = apply_bundle(self.validated(), actor=self.actor, backup_path=Path(self.tmp.name) / "second-rollback.json")
        self.assertEqual(plan["new"], [])
        self.assertEqual(Question.objects.count(), 4)
        self.assertEqual(Question.objects.filter(is_published=True).count(), 3)

    def test_apply_needs_active_staff_import_and_publish_permissions(self):
        user = get_user_model().objects.create_user(username="viewer")
        with self.assertRaises(PermissionDenied):
            apply_bundle(self.validated(), actor=user, backup_path=self.backup)
        self.assertEqual(read_state(), self.before)

    def test_bundle_checks_placeholder_and_directory_consistency(self):
        self.bundle["questions"][0]["stem"] = "没有答案位置"
        with self.assertRaises(ValidationError):
            self.validated()
        self.bundle["questions"][0]["stem"] = "{{0}}"
        self.bundle["questions"][0]["category_id"] = "missing"
        with self.assertRaisesMessage(ValidationError, "缺失或未启用目录"):
            self.validated()
