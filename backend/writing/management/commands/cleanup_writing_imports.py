from django.core.management.base import BaseCommand, CommandError

from writing.import_services import WritingImportError
from writing.import_storage import cleanup_expired_previews


class Command(BaseCommand):
    help = "清理保存超过 22 小时的应用文导入临时文件，为每小时运行预留 24 小时内清理余量。"

    def handle(self, *args, **options):
        try:
            count = cleanup_expired_previews()
        except WritingImportError as error:
            raise CommandError(error.message) from error
        self.stdout.write(self.style.SUCCESS(f"已清理 {count} 个过期应用文导入批次。"))
