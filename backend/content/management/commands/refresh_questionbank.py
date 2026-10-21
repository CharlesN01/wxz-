"""Dry-run first; apply a reviewed complete replacement or restore its snapshot."""

import hashlib
import json
from pathlib import Path

from django.contrib.auth import get_user_model
from django.core.exceptions import PermissionDenied, ValidationError
from django.core.management.base import BaseCommand, CommandError

from content.questionbank_refresh import (
    apply_bundle, check_baseline, load_bundle, make_plan, read_state, restore_backup,
)


class Command(BaseCommand):
    help = "原子替换新版文学/文言题库；默认只读预检。旧题下架，保留全部学员/修订记录。"

    def add_arguments(self, parser):
        group = parser.add_mutually_exclusive_group(required=True)
        group.add_argument("--bundle", help="本机规范化题库 JSON 路径")
        group.add_argument("--restore", help="本命令生成的回滚 JSON 路径")
        parser.add_argument("--apply", action="store_true", help="显式确认写入；不传则仅只读预检")
        parser.add_argument("--actor-id", type=int, help="具有编辑、导入、发布权限的后台账号 ID")
        parser.add_argument("--backup", help="导入写入时必须给出一个尚不存在的回滚文件路径")
        parser.add_argument("--expect-sha256", help="写入前必须核对的题库包或回滚文件 SHA-256")

    def handle(self, *args, **options):
        try:
            source = Path(options["bundle"] or options["restore"])
            raw = source.read_bytes()
            digest = hashlib.sha256(raw).hexdigest()
            if options["expect_sha256"] and options["expect_sha256"] != digest:
                raise CommandError("SHA-256 不一致，未写入。")
            actor = None
            if options["apply"]:
                if not options["expect_sha256"] or not options["actor_id"]:
                    raise CommandError("写入必须提供 --expect-sha256 和 --actor-id。")
                actor = get_user_model().objects.get(pk=options["actor_id"])
            if options["restore"]:
                data = json.loads(raw)
                if options["apply"]:
                    count = restore_backup(data, actor=actor)
                    result = {"mode": "restored", "restored_old_questions": count}
                else:
                    if data.get("schema") != "chinese-study-questionbank-rollback-v1" or read_state() != data["after"]:
                        raise CommandError("回滚快照不支持或当前题库已变化，未写入。")
                    result = {"mode": "restore-dry-run", "old_questions": len(data["before"]["questions"])}
            else:
                bundle = load_bundle(raw)
                if options["apply"]:
                    if not options["backup"]:
                        raise CommandError("导入写入必须提供 --backup，且路径不能已存在。")
                    if Path(options["backup"]).exists():
                        raise CommandError("回滚文件已存在，请使用新的路径；未写入。")
                    plan = apply_bundle(bundle, actor=actor, backup_path=options["backup"])
                else:
                    before = read_state()
                    plan = make_plan(bundle, before)
                    check_baseline(bundle, before, plan)
                result = {"mode": "applied" if options["apply"] else "dry-run", **{
                    key: len(value) if isinstance(value, list) else value for key, value in plan.items()
                }}
            self.stdout.write(json.dumps({**result, "sha256": digest}, ensure_ascii=False))
        except (OSError, ValueError, KeyError, ValidationError, PermissionDenied, get_user_model().DoesNotExist) as error:
            detail = "；".join(error.messages) if isinstance(error, ValidationError) else str(error)
            raise CommandError(detail) from error
