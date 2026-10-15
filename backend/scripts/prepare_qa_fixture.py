"""Create repeatable, local-only QA data in an explicitly named SQLite copy.

The command refuses the default database and never prints secrets or raw
activation codes. Raw codes are written to the ignored QA directory so the
developer can use them for a local redemption test.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path


def qa_path(base_dir: Path, value: str) -> Path:
    path = Path(value)
    if not path.is_absolute():
        path = base_dir / path
    path = path.resolve()
    qa_dir = (base_dir / ".local" / "qa").resolve()
    if qa_dir not in path.parents or path.suffix.lower() != ".sqlite3" or not path.name.startswith("qa-"):
        raise SystemExit("QA_PATH_INVALID: 只允许 backend/.local/qa/qa-*.sqlite3。")
    if not path.is_file():
        raise SystemExit("QA_DATABASE_MISSING: 指定的 QA SQLite 文件不存在。")
    return path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="准备隔离 QA SQLite 数据，不修改默认数据库。")
    parser.add_argument("--sqlite-path", required=True, help="相对于 backend 的 .local/qa/qa-*.sqlite3 路径")
    return parser.parse_args()


def main() -> int:
    base_dir = Path(__file__).resolve().parents[1]
    database = qa_path(base_dir, parse_args().sqlite_path)
    os.environ["DJANGO_SETTINGS_MODULE"] = "config.settings"
    os.environ["DB_ENGINE"] = "sqlite"
    os.environ["SQLITE_PATH"] = str(database.relative_to(base_dir))
    sys.path.insert(0, str(base_dir))

    import django

    django.setup()

    from activation.models import ActivationBatch
    from activation.services import generate_batch, transition_batch
    from django.contrib.auth import get_user_model
    from entitlements.models import Product
    from entitlements.services import mark_product_synced
    from feedback.models import Feedback, FeedbackType
    from resources.models import GroupResourceConfiguration
    from writing.models import WritingCategory, WritingContent, WritingGenre, WritingKind
    from writing.services import publish_writings

    User = get_user_model()
    admin, _ = User.objects.get_or_create(username="local_acceptance", defaults={"is_staff": True})
    admin.is_active = True
    admin.is_staff = True
    admin.is_superuser = True
    admin.save(update_fields=("is_active", "is_staff", "is_superuser"))

    product = Product.objects.get(pk="all-chinese")
    product.price_fen = 1000
    product.is_active = True
    product.platform_product_id = "qa-all-chinese-20261015"
    product.save()
    mark_product_synced(
        product.pk,
        admin,
        price_fen=product.price_fen,
        platform_product_id=product.platform_product_id,
    )

    qa_dir = base_dir / ".local" / "qa"
    code_file = qa_dir / "activation-codes-20261015.json"
    batch_label = "QA联调 20261015-v2"
    batch = ActivationBatch.objects.filter(label=batch_label).order_by("-created_at").first()
    raw_codes = None
    if batch is None:
        batch, raw_codes = generate_batch(admin, 2, batch_label, "qa-20261015-generate-v2")
        transition_batch(batch.pk, admin, "receive")
        transition_batch(batch.pk, admin, "enable")
        code_file.write_text(
            json.dumps({"batchId": str(batch.pk), "codes": list(raw_codes)}, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    elif code_file.is_file():
        stored = json.loads(code_file.read_text(encoding="utf-8"))
        if stored.get("batchId") != str(batch.pk) or not stored.get("codes"):
            raise SystemExit("QA_ACTIVATION_ARTIFACT_MISMATCH: 原始激活码文件与批次不一致。")
    else:
        raise SystemExit("QA_ACTIVATION_ARTIFACT_MISSING: 已有批次但找不到原始激活码文件，拒绝生成重复批次。")
    batch.refresh_from_db()
    if batch.state == "awaiting_receipt":
        transition_batch(batch.pk, admin, "receive")
        transition_batch(batch.pk, admin, "enable")
    elif batch.state == "received":
        transition_batch(batch.pk, admin, "enable")
    elif batch.state != "enabled":
        raise SystemExit("QA_ACTIVATION_BATCH_NOT_ENABLED: 现有批次状态不适合联调。")

    category, _ = WritingCategory.objects.get_or_create(
        pk="qa-notice",
        defaults={"name": "QA 应用文分类", "sort_order": 900, "is_active": True},
    )
    genre, _ = WritingGenre.objects.get_or_create(
        pk="qa-notice",
        defaults={"name": "QA 通知", "sort_order": 900, "is_active": True},
    )
    content, _ = WritingContent.objects.get_or_create(
        pk="qa-application-001",
        defaults={
            "category": category,
            "genre": genre,
            "kind": WritingKind.TEMPLATE,
            "title": "QA 联调通知模板",
            "body": "为验证应用文页面联调，特准备此条隔离测试内容。",
            "sort_order": 900,
        },
    )
    content.category = category
    content.genre = genre
    content.kind = WritingKind.TEMPLATE
    content.title = "QA 联调通知模板"
    content.body = "为验证应用文页面联调，特准备此条隔离测试内容。"
    content.reference_answer = ""
    content.sort_order = 900
    content.save()
    publish_writings(WritingContent.objects.filter(pk=content.pk), admin)

    resources, _ = GroupResourceConfiguration.objects.get_or_create(pk=1, defaults={})
    resources.group_wechat_id = "qa-study-group-20261015"
    resources.group_qr_code = ""
    resources.claim_code = "QA-20261015"
    resources.description = "QA 隔离资料群配置，二维码故意留空以验收空态。"
    resources.announcement = "仅用于本地联调，不代表正式资料群。"
    resources.is_enabled = True
    resources.updated_by = admin
    resources.save()

    student = User.objects.filter(is_active=True, is_staff=False, is_superuser=False).order_by("id").first()
    if student is None:
        student = User.objects.create_user(username="qa_student_20261015", is_active=True)
    feedback_rows = []
    for feedback_type, content_text in (
        (FeedbackType.FEATURE, "QA 联调反馈：应用文页面展示正常。"),
        (FeedbackType.QUESTION, "QA 联调反馈：请核对随机题组返回。"),
    ):
        item, _ = Feedback.objects.get_or_create(
            user=student,
            feedback_type=feedback_type,
            content=content_text,
            defaults={"contact": "qa@example.invalid"},
        )
        feedback_rows.append(item.pk)

    manifest = {
        "database": str(database),
        "adminUser": admin.username,
        "studentUser": student.username,
        "product": {"id": product.pk, "platformProductId": product.platform_product_id, "priceFen": product.price_fen},
        "activation": {"batchId": str(batch.pk), "state": batch.state, "codeFile": str(code_file)},
        "writing": {"categoryId": category.pk, "genreId": genre.pk, "contentId": content.pk, "published": content.is_published},
        "resources": {"id": resources.pk, "enabled": resources.is_enabled, "hasQrCode": bool(resources.group_qr_code), "hasClaimCode": bool(resources.claim_code)},
        "feedbackIds": feedback_rows,
        "paymentEnabled": False,
    }
    manifest_path = qa_dir / "qa-fixture-manifest-20261015.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": "ready", "manifest": str(manifest_path), "activationCodeFile": str(code_file), "paymentEnabled": False}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
