import os
import uuid
from pathlib import Path

from django.conf import settings
from django.core.exceptions import ValidationError
from django.core.files.storage import FileSystemStorage


MAX_AGENT_WECHAT_QR_SIZE = 2 * 1024 * 1024
IMAGE_SIGNATURES = {
    ".png": ("image/png", lambda header: header.startswith(b"\x89PNG\r\n\x1a\n")),
    ".jpg": ("image/jpeg", lambda header: header.startswith(b"\xff\xd8\xff")),
    ".jpeg": ("image/jpeg", lambda header: header.startswith(b"\xff\xd8\xff")),
    ".webp": ("image/webp", lambda header: header.startswith(b"RIFF") and header[8:12] == b"WEBP"),
}


def validate_agent_wechat_qr(upload):
    extension = Path(upload.name).suffix.lower()
    signature = IMAGE_SIGNATURES.get(extension)
    if signature is None or (
        getattr(upload, "content_type", None) and upload.content_type != signature[0]
    ):
        raise ValidationError("代理微信二维码仅支持 PNG、JPEG 或 WebP 图片，扩展名和类型必须匹配。")
    if upload.size > MAX_AGENT_WECHAT_QR_SIZE:
        raise ValidationError("代理微信二维码图片不能超过 2MB。")

    position = upload.tell() if hasattr(upload, "tell") else 0
    header = upload.read(12)
    upload.seek(position)
    if not signature[1](header):
        raise ValidationError("图片内容与声明的格式不一致。")


def agent_wechat_qr_upload_to(_instance, filename):
    extension = Path(filename).suffix.lower()
    return f"distribution/agent-wechat/{uuid.uuid4().hex}{extension}"


class PublicAgentWechatQRStorage(FileSystemStorage):
    def __init__(self):
        super().__init__(
            location=settings.MEDIA_ROOT,
            base_url=settings.MEDIA_URL,
            file_permissions_mode=0o644,
            directory_permissions_mode=0o755,
        )

    def _save(self, name, content):
        stored_name = super()._save(name, content)
        root = Path(self.location).resolve()
        directory = Path(self.path(stored_name)).resolve().parent
        while directory != root and root in directory.parents:
            os.chmod(directory, 0o755)
            directory = directory.parent
        return stored_name
