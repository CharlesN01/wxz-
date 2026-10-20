"""Opt-in import preview benchmark, kept separate from normal regressions."""

from io import BytesIO
import json
import os
from time import perf_counter
from unittest import skipUnless

from django.contrib.auth import get_user_model
from django.db import connection
from django.test import TestCase
from openpyxl import Workbook

from writing.import_files import parse_workbook
from writing.import_services import build_import_preview


@skipUnless(os.environ.get("WRITING_IMPORT_BENCHMARK") == "1", "Explicit benchmark run only.")
class WritingImportBenchmark(TestCase):
    def test_thousand_row_preview(self):
        actor = get_user_model().objects.create_superuser(username="import-benchmark")
        workbook = Workbook()
        sheet = workbook.active
        sheet.title = "应用文"
        sheet.append(["内容编号", "分类编号", "文种编号", "内容类型", "标题", "正文", "参考答案", "排序"])
        kinds = ("template", "example", "past_exam", "exercise")
        for index in range(1000):
            kind = kinds[index % 4]
            sheet.append([
                f"bench-{index:04d}", "bench-category", "bench-genre", kind,
                f"性能样本{index}", "文" * 500, "答" * 400 if kind == "exercise" else "", index,
            ])
        for name, headers, values in (
            ("分类", ["分类编号", "分类名称", "排序"], ["bench-category", "性能分类", 0]),
            ("文种", ["文种编号", "文种名称", "排序"], ["bench-genre", "性能文种", 0]),
        ):
            worksheet = workbook.create_sheet(name)
            worksheet.append(headers)
            worksheet.append(values)
        stream = BytesIO()
        workbook.save(stream)
        workbook.close()
        raw = stream.getvalue()
        measurements = []
        for _ in range(3):
            started = perf_counter()
            parsed = parse_workbook(raw, "performance.xlsx")
            preview = build_import_preview(parsed, actor, "create_only")
            measurements.append(perf_counter() - started)
            self.assertTrue(preview["canConfirm"], preview["issues"][:3])
            self.assertEqual(preview["counts"]["create"], 1000)
        print("WRITING_IMPORT_BENCHMARK=" + json.dumps({
            "database": connection.vendor, "rows": 1000, "bodyChars": 500,
            "meanAnswerChars": 100, "uploadBytes": len(raw),
            "seconds": measurements, "maxSeconds": max(measurements),
        }))
        self.assertLess(max(measurements), 10, "1000-row preview exceeded the requested 10-second target.")
