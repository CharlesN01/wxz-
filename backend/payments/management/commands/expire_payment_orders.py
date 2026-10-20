import time

from django.core.management.base import BaseCommand, CommandError
from django.db import close_old_connections, connection
from payments.expiration import expire_due_orders


class Command(BaseCommand):
    help = "直接取消创建已满 2 分钟的未付款订单并释放占位，不调用微信查单。"

    def add_arguments(self, parser):
        parser.add_argument("--limit", type=int, default=200)
        parser.add_argument("--watch", action="store_true")
        parser.add_argument("--interval", type=int, default=1)

    def handle(self, *args, **options):
        if not 1 <= options["limit"] <= 1000 or not 1 <= options["interval"] <= 60:
            raise CommandError("limit 必须为 1～1000，interval 必须为 1～60 秒。")
        while True:
            # call_command may run inside an existing transaction. Closing that
            # connection would abort its caller's work on PostgreSQL.
            if not connection.in_atomic_block:
                close_old_connections()
            count = expire_due_orders(limit=options["limit"])
            if count or not options["watch"]:
                self.stdout.write(f"已自动取消 {count} 个超时订单。")
            if not options["watch"]:
                return
            time.sleep(options["interval"])
