from pathlib import Path
from tempfile import TemporaryDirectory

from django.test import SimpleTestCase
from openpyxl import Workbook

from scripts.prepare_questionbank_refresh import BASE_HEADERS, prepare


class QuestionbankPrepareTests(SimpleTestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.category = {"id": "pre-qin", "name": "先秦文学", "sort_order": 1, "is_active": True}
        self.article = {"id": "zhengbo", "title": "郑伯克段于鄢", "sort_order": 1, "is_active": True}
        self.old = {
            "categories": [self.category], "articles": [self.article], "questions": [
                self.old_question("lit-000001", "literature", "fact", "旧的一题{{0}}", ["旧答案"]),
                self.old_question("lit-000002", "literature", "fact", "真正同一道题{{0}}", ["待修正答案"]),
                self.old_question("cla-word-000001", "classical", "word", "{{0}}，郑武公{{1}}。", ["初：当初", "娶于申：从申国娶妻"]),
            ],
        }

    def old_question(self, qid, source, qtype, stem, answers):
        return {
            "id": qid, "source": source, "type": qtype, "stem": stem, "answers": answers,
            "tag": "", "category_id": "pre-qin" if source == "literature" else None,
            "article_id": "zhengbo" if source == "classical" else None, "sort_order": 1,
            "is_published": True, "published_revision_id": 1,
        }

    def workbook(self, name, rows):
        book = Workbook()
        book.active.title = "题库"
        book.active.append([*BASE_HEADERS, "答案1", "答案2"])
        for row in rows:
            book.active.append(row)
        path = self.root / name
        book.save(path)
        book.close()
        return path

    def fixture(self, *, duplicate=False):
        import json
        snapshot = self.root / "snapshot.json"
        snapshot.write_text(json.dumps(self.old), encoding="utf-8")
        literature = [
            ["lit-000001", "literature", "先秦", None, "fact", "文学常识", 1, "真正同一道题{{0}}", "修正答案", None],
            ["lit-000002", "literature", "先秦", None, "fact", "文学常识", 2, "全新题目{{0}}", "新答案", None],
        ]
        if duplicate:
            literature.append(["lit-000003", "literature", "先秦", None, "fact", "文学常识", 3, "真正同一道题{{0}}", "另一答案", None])
        return {
            "literature": self.workbook("文学.xlsx", literature),
            "words": self.workbook("字词.xlsx", [["cla-word-000001", "classical", None, "郑伯克段于鄢", "word", "重点字词", 1, "（初），郑武公（娶于申）。", "初：当初", "娶于申：从申国娶妻"]]),
            "translations": self.workbook("翻译.xlsx", [["cla-trans-000001", "classical", None, "郑伯克段于鄢", "translation", "重点翻译", 1, "原句_x000D_\n下一行。", "译文完整。", None]]),
            "snapshot": snapshot, "namespace": "qb20261021",
        }

    def test_renumbered_file_ids_never_overwrite_different_historical_questions(self):
        bundle, report = prepare(**self.fixture())
        rows = {row["source_id"]: row for row in bundle["questions"]}
        self.assertEqual(rows["lit-000001"]["id"], "lit-000002")
        self.assertEqual(rows["lit-000002"]["id"], "qb20261021-lit-000002")
        self.assertEqual(rows["lit-000001"]["answers"], ["修正答案"])
        self.assertIn("lit-000001", report["archive_old_ids"])
        self.assertEqual(rows["cla-word-000001"]["id"], "cla-word-000001")

    def test_original_word_and_translation_text_remain_complete(self):
        bundle, report = prepare(**self.fixture())
        word = next(row for row in bundle["questions"] if row["type"] == "word")
        translation = next(row for row in bundle["questions"] if row["type"] == "translation")
        self.assertEqual(word["stem"], "（初），郑武公（娶于申）。\n释义1：{{0}}\n释义2：{{1}}")
        self.assertEqual(word["answers"], ["初：当初", "娶于申：从申国娶妻"])
        self.assertEqual(translation["stem"], "原句\n下一行。\n参考译文：{{0}}")
        self.assertEqual(report["total"], 4)
        self.assertEqual(len(report["mapping"]), 4)

    def test_ambiguous_duplicates_are_preserved_as_separate_new_questions(self):
        bundle, report = prepare(**self.fixture(duplicate=True))
        duplicate = [row for row in bundle["questions"] if row["stem"] == "真正同一道题{{0}}"]
        self.assertEqual(len(duplicate), 2)
        self.assertEqual(len({row["id"] for row in duplicate}), 2)
        self.assertTrue(all(row["id"].startswith("qb20261021-") for row in duplicate))
        self.assertEqual(report["mapping_counts"]["ambiguous_kept_as_new"], 2)

    def test_source_namespace_collision_fails_instead_of_overwriting(self):
        self.old["questions"].append(self.old_question("qb20261021-lit-000002", "literature", "fact", "另一道已有题{{0}}", ["另题答案"]))
        with self.assertRaisesRegex(ValueError, "新命名空间已存在题号"):
            prepare(**self.fixture())
