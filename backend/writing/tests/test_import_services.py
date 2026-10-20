import copy
import io
import json
import os
from datetime import timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from django.contrib.admin.models import LogEntry
from django.contrib.auth import get_user_model
from django.contrib.auth.models import AnonymousUser, Permission
from django.core.management import call_command
from django.db import DatabaseError
from django.test import TestCase, override_settings
from django.utils import timezone

from writing.import_services import (
    WritingImportError, build_import_preview, confirm_import, has_import_permission,
)
from writing.import_storage import cleanup_expired_previews, load_preview, save_preview
from writing.models import WritingCategory, WritingContent, WritingGenre, WritingRevision


class ImportFixture:
    def setUp(self):
        super().setUp()
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.settings_override = override_settings(WRITING_IMPORT_TMP_DIR=self.directory.name)
        self.settings_override.enable()
        self.addCleanup(self.settings_override.disable)
        self.actor = get_user_model().objects.create_superuser(username="import-operator", password="test")
        self.category = WritingCategory.objects.create(id="daily", name="日常应用文", sort_order=1)
        self.genre = WritingGenre.objects.create(id="notice", name="通知", sort_order=1)

    def parsed(self, **values):
        return {"contents": [{"row": 2, "values": {
            "id": "new-notice", "category_id": "daily", "genre_id": "notice", "kind": "template",
            "title": "通知格式", "body": "  第一行\n\n第二行", "reference_answer": "", "sort_order": 0,
            **values,
        }}], "categories": [], "genres": [], "issues": []}

    def preview(self, parsed=None, mode="create_only"):
        return save_preview(self.actor, b"test workbook bytes", build_import_preview(parsed or self.parsed(), self.actor, mode))

    def existing(self, **changes):
        return WritingContent.objects.create(**{**self.parsed()["contents"][0]["values"], **changes})

    def assert_error(self, code, action, status=None):
        with self.assertRaises(WritingImportError) as caught:
            action()
        self.assertEqual(caught.exception.code, code)
        if status:
            self.assertEqual(caught.exception.status, status)
        return caught.exception

    def grant(self, user, *permissions):
        user.user_permissions.add(*Permission.objects.filter(content_type__app_label="writing", codename__in=permissions))


class ImportServiceTests(ImportFixture, TestCase):
    def test_preview_is_read_only_and_contains_all_field_differences(self):
        content = self.existing(title="原标题", genre_id=None, sort_order=8)
        preview = build_import_preview(self.parsed(), self.actor, "upsert_draft")
        self.assertEqual(preview["counts"], {"create": 0, "update": 1, "unchanged": 0, "errors": 0})
        self.assertEqual({change["field"] for change in preview["rows"][0]["changes"]}, {"title", "genre_id", "sort_order"})
        content.refresh_from_db()
        self.assertEqual(content.title, "原标题")
        self.assertFalse(LogEntry.objects.exists())

    def test_normalized_existing_is_unchanged_and_not_rewritten(self):
        content = self.existing(title=" 通知格式 ", body="  第一行\r\n\r第二行")
        updated_at = content.updated_at
        preview = self.preview()
        self.assertEqual(preview["counts"]["unchanged"], 1)
        result = confirm_import(preview, self.actor)
        content.refresh_from_db()
        self.assertEqual(content.updated_at, updated_at)
        self.assertEqual(result["counts"], {"created": 0, "updated": 0, "unchanged": 1})
        self.assertEqual(LogEntry.objects.count(), 1)

    def test_create_only_conflict_and_invalid_mode(self):
        self.existing(title="原标题")
        preview = self.preview()
        self.assertFalse(preview["canConfirm"])
        self.assertIsNone(preview["confirmationToken"])
        self.assertIn("EXISTING_CONTENT_CONFLICT", [issue["code"] for issue in preview["issues"]])
        self.assert_error("INVALID_MODE", lambda: build_import_preview(self.parsed(), self.actor, "delete"))

    def test_create_new_dictionaries_and_draft(self):
        parsed = self.parsed(category_id="new-category", genre_id="new-genre")
        parsed["categories"] = [{"row": 2, "values": {"id": "new-category", "name": "新分类", "sort_order": 2}}]
        parsed["genres"] = [{"row": 2, "values": {"id": "new-genre", "name": "新文种", "sort_order": 2}}]
        preview = self.preview(parsed)
        self.assertEqual(preview["dictionaries"], {"categoriesToCreate": 1, "genresToCreate": 1})
        result = confirm_import(preview, self.actor)
        content = WritingContent.objects.get(pk="new-notice")
        self.assertFalse(content.is_published)
        self.assertIsNone(content.published_revision_id)
        self.assertTrue(content.category.is_active)
        self.assertFalse(result["published"])
        self.assertEqual(content.body, "  第一行\n\n第二行")

    def test_dictionary_reuse_mismatch_disabled_missing_and_unreferenced(self):
        for name, order, active, expected in (("日常应用文", 1, True, None), ("改名", 1, True, "DICTIONARY_CONFLICT"),
                                              ("日常应用文", 2, True, "DICTIONARY_CONFLICT"), ("日常应用文", 1, False, "RELATED_DISABLED")):
            with self.subTest(name=name, order=order, active=active):
                WritingCategory.objects.filter(pk="daily").update(is_active=active)
                parsed = self.parsed()
                parsed["categories"] = [{"row": 2, "values": {"id": "daily", "name": name, "sort_order": order}}]
                preview = build_import_preview(parsed, self.actor, "create_only")
                if expected:
                    self.assertIn(expected, [issue["code"] for issue in preview["issues"]])
                else:
                    self.assertTrue(preview["canConfirm"])
        parsed = self.parsed(category_id="missing")
        self.assertIn("RELATED_NOT_FOUND", [issue["code"] for issue in build_import_preview(parsed, self.actor, "create_only")["issues"]])
        parsed["categories"] = [{"row": 2, "values": {"id": "unused", "name": "未引用", "sort_order": 0}}]
        self.assertIn("UNREFERENCED_DICTIONARY", [issue["code"] for issue in build_import_preview(parsed, self.actor, "create_only")["issues"]])

    def test_dictionary_same_name_under_other_id_is_rejected(self):
        parsed = self.parsed(category_id="second-daily")
        parsed["categories"] = [{"row": 2, "values": {"id": "second-daily", "name": "日常应用文", "sort_order": 1}}]
        self.assertIn("DICTIONARY_CONFLICT", [issue["code"] for issue in build_import_preview(parsed, self.actor, "create_only")["issues"]])

    def test_same_name_new_dictionary_rows_in_one_batch_are_rejected(self):
        parsed = self.parsed(category_id="first")
        parsed["contents"].append({"row": 3, "values": {**parsed["contents"][0]["values"], "id": "second", "category_id": "second"}})
        parsed["categories"] = [{"row": row, "values": {"id": pk, "name": "相同新名", "sort_order": 0}} for row, pk in ((2, "first"), (3, "second"))]
        self.assertFalse(build_import_preview(parsed, self.actor, "create_only")["canConfirm"])

    def test_parser_issues_are_kept_and_bad_rows_marked(self):
        parsed = self.parsed(title="")
        issue = {"sheet": "应用文", "row": 2, "column": "标题", "code": "REQUIRED_FIELD", "message": "请填写标题。"}
        parsed["issues"].append(issue)
        preview = build_import_preview(parsed, self.actor, "create_only")
        self.assertEqual(preview["issues"], [issue])
        self.assertEqual(preview["rows"][0]["action"], "error")
        self.assertFalse(preview["canConfirm"])

    def test_updating_published_content_keeps_every_published_revision(self):
        content = self.existing(body="旧发布正文")
        revision = WritingRevision.objects.create(content=content, version=1, created_by=self.actor, **content.content_payload())
        content.published_revision = revision
        content.is_published = True
        content.save()
        preview = self.preview(self.parsed(genre_id=None, sort_order=0), "upsert_draft")
        confirm_import(preview, self.actor)
        content.refresh_from_db()
        self.assertIsNone(content.genre_id)
        self.assertTrue(content.is_published)
        self.assertEqual(content.published_revision_id, revision.pk)
        self.assertEqual(content.published_revision.body, "旧发布正文")
        self.assertEqual(content.revisions.count(), 1)

    def test_dependency_changes_and_id_occupation_require_new_preview(self):
        for mutate in (
            lambda: WritingCategory.objects.filter(pk="daily").update(sort_order=9),
            lambda: WritingGenre.objects.filter(pk="notice").update(is_active=False),
            lambda: self.existing(),
        ):
            with self.subTest(mutate=mutate):
                preview = self.preview()
                mutate()
                self.assert_error("PREVIEW_CONFLICT", lambda: confirm_import(preview, self.actor), 409)
                self.assertFalse(LogEntry.objects.exists())
                # TestCase rolls this subtest's temporary database changes back explicitly.
                if WritingContent.objects.exists():
                    WritingContent.objects.all()._raw_delete("default")
                WritingCategory.objects.filter(pk="daily").update(sort_order=1)
                WritingGenre.objects.filter(pk="notice").update(is_active=True)

    def test_publish_or_unpublish_after_preview_conflicts(self):
        content = self.existing(title="旧标题")
        preview = self.preview(mode="upsert_draft")
        revision = WritingRevision.objects.create(content=content, version=1, **content.content_payload())
        WritingContent.objects.filter(pk=content.pk).update(is_published=True, published_revision=revision)
        self.assert_error("PREVIEW_CONFLICT", lambda: confirm_import(preview, self.actor))
        preview = self.preview(mode="upsert_draft")
        WritingContent.objects.filter(pk=content.pk).update(is_published=False)
        self.assert_error("PREVIEW_CONFLICT", lambda: confirm_import(preview, self.actor))

    def test_new_same_name_dictionary_inserted_after_preview_conflicts(self):
        parsed = self.parsed(category_id="new-category")
        parsed["categories"] = [{"row": 2, "values": {"id": "new-category", "name": "并发新名", "sort_order": 0}}]
        preview = self.preview(parsed)
        WritingCategory.objects.create(id="other-id", name="并发新名")
        self.assert_error("PREVIEW_CONFLICT", lambda: confirm_import(preview, self.actor))
        self.assertFalse(WritingContent.objects.exists())

    def test_replay_returns_durable_result_without_overwriting_later_edits(self):
        preview = self.preview()
        first = confirm_import(preview, self.actor)
        WritingContent.objects.filter(pk="new-notice").update(title="稍后人工编辑")
        replay = confirm_import(load_preview(preview["previewId"], self.actor, token=preview["confirmationToken"]), self.actor)
        self.assertEqual(first["status"], "completed")
        self.assertEqual(replay["status"], "already_completed")
        self.assertEqual(WritingContent.objects.get().title, "稍后人工编辑")
        self.assertEqual(LogEntry.objects.count(), 1)
        self.assertIn("result", load_preview(preview["previewId"], self.actor))
        audit = LogEntry.objects.get().change_message
        self.assertNotIn("第一行", audit)
        self.assertNotIn("通知格式", audit)

    def test_audit_failure_rolls_back_dictionaries_and_contents(self):
        parsed = self.parsed(category_id="new-category")
        parsed["categories"] = [{"row": 2, "values": {"id": "new-category", "name": "新分类", "sort_order": 0}}]
        preview = self.preview(parsed)
        with patch("writing.import_services.LogEntry.objects.create", side_effect=DatabaseError("audit unavailable")):
            self.assert_error("IMPORT_UNAVAILABLE", lambda: confirm_import(preview, self.actor), 503)
        self.assertFalse(WritingCategory.objects.filter(pk="new-category").exists())
        self.assertFalse(WritingContent.objects.exists())
        self.assertFalse(LogEntry.objects.exists())

    def test_no_token_never_confirms_and_tampered_in_memory_plan_is_ignored(self):
        preview = self.preview()
        missing = copy.deepcopy(preview)
        missing["confirmationToken"] = None
        self.assert_error("INVALID_CONFIRMATION", lambda: confirm_import(missing, self.actor))
        preview["plan"]["contents"][0]["values"]["body"] = "调用者篡改"
        confirm_import(preview, self.actor)
        self.assertEqual(WritingContent.objects.get().body, "  第一行\n\n第二行")

    def test_permissions_are_fresh_and_update_and_dictionary_permissions_are_separate(self):
        user = get_user_model().objects.create_user(username="editor", is_staff=True)
        self.assertFalse(has_import_permission(AnonymousUser()))
        self.assertFalse(has_import_permission(user))
        self.grant(user, "view_writingcontent", "add_writingcontent")
        self.assertTrue(has_import_permission(user))
        preview = save_preview(user, b"file", build_import_preview(self.parsed(), user, "create_only"))
        # Populate the caller's permission cache before revocation.
        user.has_perm("writing.add_writingcontent")
        user.user_permissions.remove(Permission.objects.get(content_type__app_label="writing", codename="add_writingcontent"))
        self.assert_error("PERMISSION_DENIED", lambda: confirm_import(preview, user), 403)
        self.grant(user, "add_writingcontent")
        self.existing(title="旧")
        self.assert_error("PERMISSION_DENIED", lambda: build_import_preview(self.parsed(), user, "upsert_draft"), 403)
        self.grant(user, "change_writingcontent")
        self.assertTrue(build_import_preview(self.parsed(), user, "upsert_draft")["canConfirm"])
        parsed = self.parsed(id="other", category_id="new-category")
        parsed["categories"] = [{"row": 2, "values": {"id": "new-category", "name": "新分类", "sort_order": 0}}]
        self.assert_error("PERMISSION_DENIED", lambda: build_import_preview(parsed, user, "create_only"), 403)

    def test_disabled_staff_and_agent_accounts_are_rejected(self):
        from config.admin_navigation import AGENT_VIEW_PERMISSIONS
        user = get_user_model().objects.create_user(username="agent", is_staff=True)
        self.grant(user, "view_writingcontent", "add_writingcontent")
        for value in AGENT_VIEW_PERMISSIONS:
            app, codename = value.split(".")
            user.user_permissions.add(Permission.objects.get(content_type__app_label=app, codename=codename))
        self.assertFalse(has_import_permission(user))
        get_user_model().objects.filter(pk=self.actor.pk).update(is_active=False)
        self.assert_error("PERMISSION_DENIED", lambda: self.preview(), 403)


class ImportStorageTests(ImportFixture, TestCase):
    def test_owner_bound_and_paths_are_not_accepted(self):
        preview = self.preview()
        other = get_user_model().objects.create_superuser(username="other", password="test")
        self.assert_error("PERMISSION_DENIED", lambda: load_preview(preview["previewId"], other), 403)
        for value in ("../", "../../plan.json", "not-a-uuid", None):
            self.assert_error("PREVIEW_NOT_FOUND", lambda: load_preview(value, self.actor), 404)

    def test_expired_previews_and_signatures_are_rejected(self):
        preview = self.preview()
        with patch("writing.import_storage.timezone.now", return_value=timezone.now() + timedelta(minutes=31)):
            self.assert_error("PREVIEW_EXPIRED", lambda: load_preview(preview["previewId"], self.actor), 410)
        self.assert_error("INVALID_CONFIRMATION", lambda: load_preview(preview["previewId"], self.actor, token=""))
        self.assert_error("PREVIEW_CONFLICT", lambda: load_preview(preview["previewId"], self.actor, token="bad-token"))

    def test_raw_file_and_persisted_plan_tampering_are_rejected(self):
        preview = self.preview()
        folder = Path(self.directory.name) / preview["previewId"]
        (folder / "raw.xlsx").write_bytes(b"tampered")
        self.assert_error("PREVIEW_CONFLICT", lambda: load_preview(preview["previewId"], self.actor), 409)
        preview = self.preview()
        path = Path(self.directory.name) / preview["previewId"] / "plan.json"
        saved = json.loads(path.read_text(encoding="utf-8"))
        saved["plan"]["contents"][0]["values"]["body"] = "篡改正文"
        path.write_text(json.dumps(saved), encoding="utf-8")
        self.assert_error("PREVIEW_CONFLICT", lambda: load_preview(preview["previewId"], self.actor, token=preview["confirmationToken"]))

    def test_signature_cannot_be_reused_for_a_different_batch(self):
        first, second = self.preview(), self.preview()
        self.assert_error("INVALID_CONFIRMATION", lambda: load_preview(second["previewId"], self.actor, token=first["confirmationToken"]))

    def test_corrupt_nested_plan_types_return_conflict_instead_of_server_error(self):
        for value in ([], None, "not a plan", {"contents": [None]}):
            with self.subTest(value=value):
                preview = self.preview()
                path = Path(self.directory.name) / preview["previewId"] / "plan.json"
                saved = json.loads(path.read_text(encoding="utf-8"))
                saved["plan"] = value
                path.write_text(json.dumps(saved), encoding="utf-8")
                self.assert_error("PREVIEW_CONFLICT", lambda: load_preview(preview["previewId"], self.actor), 409)

    def test_missing_and_corrupt_files_fail_closed(self):
        preview = self.preview()
        path = Path(self.directory.name) / preview["previewId"] / "plan.json"
        path.write_text("{bad-json", encoding="utf-8")
        self.assert_error("PREVIEW_CONFLICT", lambda: load_preview(preview["previewId"], self.actor))
        path.unlink()
        self.assert_error("PREVIEW_NOT_FOUND", lambda: load_preview(preview["previewId"], self.actor))

    def test_cleanup_removes_only_managed_old_directories_and_preserves_audit(self):
        old, recent = self.preview(), self.preview(self.parsed(id="recent"))
        confirm_import(old, self.actor)
        old_folder = Path(self.directory.name) / old["previewId"]
        timestamp = (timezone.now() - timedelta(hours=23)).timestamp()
        os.utime(old_folder, (timestamp, timestamp))
        unrelated = Path(self.directory.name) / "leave-user-files"
        unrelated.mkdir()
        os.utime(unrelated, (timestamp, timestamp))
        self.assertEqual(cleanup_expired_previews(), 1)
        self.assertFalse(old_folder.exists())
        self.assertTrue((Path(self.directory.name) / recent["previewId"]).exists())
        self.assertTrue(unrelated.exists())
        self.assertEqual(LogEntry.objects.count(), 1)
        output = io.StringIO()
        call_command("cleanup_writing_imports", stdout=output)
        self.assertIn("已清理 0 个", output.getvalue())

    def test_public_storage_or_disk_error_returns_service_error_without_preview(self):
        with override_settings(MEDIA_ROOT=self.directory.name):
            self.assert_error("IMPORT_UNAVAILABLE", lambda: self.preview(), 503)
        with patch("writing.import_storage._atomic_write", side_effect=OSError("disk full")):
            self.assert_error("IMPORT_UNAVAILABLE", lambda: self.preview(), 503)
        self.assertEqual(list(Path(self.directory.name).iterdir()), [])

    def test_database_outage_in_permissions_or_audit_read_returns_service_error(self):
        preview = self.preview()
        with patch("writing.import_services._fresh_actor", side_effect=DatabaseError("database down")):
            self.assert_error("IMPORT_UNAVAILABLE", lambda: load_preview(preview["previewId"], self.actor), 503)
        with patch("writing.import_storage.completed_import_result", side_effect=DatabaseError("audit read down")):
            self.assert_error("IMPORT_UNAVAILABLE", lambda: load_preview(preview["previewId"], self.actor), 503)
