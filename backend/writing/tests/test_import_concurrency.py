"""Real PostgreSQL concurrent transactions; deliberately skipped on SQLite."""

from concurrent.futures import ThreadPoolExecutor
from threading import Barrier, Event
from unittest import skipUnless
from unittest.mock import patch

from django.contrib.admin.models import LogEntry
from django.contrib.auth import get_user_model
from django.db import close_old_connections, connection, connections, transaction
from django.test import TransactionTestCase

from writing.import_services import WritingImportError, confirm_import
from writing.import_storage import load_preview
from writing.models import WritingCategory, WritingContent
from .test_import_services import ImportFixture


@skipUnless(connection.vendor == "postgresql", "需使用隔离 PostgreSQL 测试库验证真实并发事务。")
class ImportConcurrencyTests(ImportFixture, TransactionTestCase):
    def run_concurrently(self, previews):
        barrier = Barrier(len(previews))
        actor_id = self.actor.pk

        def worker(preview):
            close_old_connections()
            try:
                actor = get_user_model().objects.get(pk=actor_id)
                loaded = load_preview(preview["previewId"], actor, token=preview["confirmationToken"])
                barrier.wait(timeout=10)
                try:
                    return confirm_import(loaded, actor)
                except WritingImportError as error:
                    return {"error": error.code, "status": error.status}
            finally:
                connections.close_all()

        with ThreadPoolExecutor(max_workers=len(previews)) as pool:
            return list(pool.map(worker, previews, timeout=25))

    def test_same_batch_double_confirm_commits_only_once(self):
        preview = self.preview()
        results = self.run_concurrently([preview, preview])
        self.assertEqual({result["status"] for result in results}, {"completed", "already_completed"})
        self.assertEqual(WritingContent.objects.count(), 1)
        self.assertEqual(LogEntry.objects.count(), 1)

    def test_different_batches_competing_for_absent_content_id_conflict(self):
        previews = [self.preview(), self.preview(self.parsed(title="另一批标题"))]
        results = self.run_concurrently(previews)
        self.assertEqual(sum(result.get("status") == "completed" for result in results), 1)
        self.assertEqual(sum(result.get("error") == "PREVIEW_CONFLICT" for result in results), 1)
        self.assertEqual(WritingContent.objects.count(), 1)
        self.assertEqual(LogEntry.objects.count(), 1)

    def test_different_batches_updating_same_draft_only_one_uses_preview_version(self):
        self.existing(title="原标题")
        previews = [self.preview(self.parsed(title=title), "upsert_draft") for title in ("第一批", "第二批")]
        results = self.run_concurrently(previews)
        self.assertEqual(sum(result.get("status") == "completed" for result in results), 1)
        self.assertEqual(sum(result.get("error") == "PREVIEW_CONFLICT" for result in results), 1)
        self.assertIn(WritingContent.objects.get().title, ("第一批", "第二批"))
        self.assertEqual(LogEntry.objects.count(), 1)

    def test_ordinary_dictionary_insert_in_progress_is_seen_before_import_writes(self):
        from writing.import_services import _lock_dictionary_tables
        parsed = self.parsed(category_id="new-category")
        parsed["categories"] = [{"row": 2, "values": {"id": "new-category", "name": "并发字典名", "sort_order": 0}}]
        preview = self.preview(parsed)
        attempted = Event()
        actor_id = self.actor.pk

        def acquire(preview):
            attempted.set()
            _lock_dictionary_tables(preview)

        def importer():
            close_old_connections()
            try:
                actor = get_user_model().objects.get(pk=actor_id)
                try:
                    return confirm_import(preview, actor)
                except WritingImportError as error:
                    return error.code
            finally:
                connections.close_all()

        with ThreadPoolExecutor(max_workers=1) as pool:
            with patch("writing.import_services._lock_dictionary_tables", side_effect=acquire):
                with transaction.atomic():
                    WritingCategory.objects.create(id="ordinary-admin-id", name="并发字典名")
                    future = pool.submit(importer)
                    self.assertTrue(attempted.wait(timeout=5))
                    # The ordinary admin transaction now commits; the blocked import
                    # obtains its table locks and must see this committed name.
                self.assertEqual(future.result(timeout=10), "PREVIEW_CONFLICT")
        self.assertFalse(WritingCategory.objects.filter(pk="new-category").exists())
        self.assertFalse(WritingContent.objects.exists())
        self.assertFalse(LogEntry.objects.exists())
