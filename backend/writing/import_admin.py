"""Chinese admin workflow for XLSX imports; business writes live in the services."""

from urllib.parse import urlencode

from django import forms
from django.db import DatabaseError
from django.http import HttpResponse, HttpResponseNotAllowed, HttpResponseRedirect
from django.template.response import TemplateResponse
from django.urls import path, reverse
from django.utils.dateparse import parse_datetime

from .import_files import make_error_report, make_template, parse_workbook
from .import_services import (
    WritingImportError,
    build_import_preview,
    confirm_import,
    has_import_permission,
)
from .import_storage import load_preview, save_preview
from .models import WritingCategory, WritingGenre


XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
MAX_UPLOAD_BYTES = 5 * 1024 * 1024


class WritingImportUploadForm(forms.Form):
    import_file = forms.FileField(
        label="Excel 文件",
        widget=forms.ClearableFileInput(attrs={"accept": ".xlsx", "class": "writing-file-input"}),
        error_messages={"required": "请选择按模板填写的 .xlsx 文件。"},
    )
    mode = forms.ChoiceField(
        label="导入模式",
        choices=(("create_only", "仅新增（推荐）"), ("upsert_draft", "新增及更新草稿")),
        initial="create_only",
        widget=forms.RadioSelect,
        error_messages={"invalid_choice": "请选择页面提供的导入模式。"},
    )


class WritingImportAdminMixin:
    change_list_template = "admin/writing/writingcontent/change_list.html"
    import_template_name = "admin/writing/writingcontent/import.html"

    def get_urls(self):
        return [
            path("import/", self.admin_site.admin_view(self.import_view), name="writing_writingcontent_import"),
            path("import/confirm/", self.admin_site.admin_view(self.confirm_import_view), name="writing_writingcontent_import_confirm"),
            path("import/template/", self.admin_site.admin_view(self.import_template_view), name="writing_writingcontent_import_template"),
            path("import/report/<uuid:preview_id>/", self.admin_site.admin_view(self.import_report_view), name="writing_writingcontent_import_report"),
        ] + super().get_urls()

    def get_changelist(self, request, **kwargs):
        base = super().get_changelist(request, **kwargs)

        class ImportBatchChangeList(base):
            def get_filters_params(self, params=None):
                values = super().get_filters_params(params)
                values.pop("import_batch", None)
                return values

        return ImportBatchChangeList

    def get_queryset(self, request):
        queryset = super().get_queryset(request)
        batch = getattr(request, "_writing_import_batch", None)
        if batch is not None:
            queryset = queryset.filter(pk__in=batch["contentIds"])
        return queryset

    def changelist_view(self, request, extra_context=None):
        batch_id = request.GET.get("import_batch")
        try:
            batch = None
            if batch_id:
                self._require_import_permission(request)
                preview = load_preview(batch_id, request.user)
                batch = preview.get("result")
                if batch is None:
                    raise WritingImportError("IMPORT_NOT_COMPLETED", "该预览尚未完成导入，请先确认导入。", 400)
                request._writing_import_batch = batch
            return super().changelist_view(request, {
                **(extra_context or {}),
                "can_import_writing": has_import_permission(request.user),
                "writing_import_batch": batch,
                "writing_import_batch_url": self._import_url(batch_id) if batch_id else None,
            })
        except WritingImportError as error:
            return self._import_error(request, error)
        except (OSError, DatabaseError):
            return self._unavailable(request)

    def _require_import_permission(self, request):
        if not has_import_permission(request.user):
            raise WritingImportError("PERMISSION_DENIED", "当前账号没有应用文导入权限，请联系管理员开通查看和新增权限。", 403)

    def _import_url(self, preview_id=None):
        url = reverse("admin:writing_writingcontent_import")
        return url + "?" + urlencode({"preview_id": str(preview_id)}) if preview_id else url

    def _import_context(self, request, **values):
        return {
            **self.admin_site.each_context(request),
            "title": "应用文批量导入",
            "opts": self.model._meta,
            "import_url": self._import_url(),
            "template_url": reverse("admin:writing_writingcontent_import_template"),
            "confirm_url": reverse("admin:writing_writingcontent_import_confirm"),
            "changelist_url": reverse("admin:writing_writingcontent_changelist"),
            "form": WritingImportUploadForm(),
            "can_import_writing": has_import_permission(request.user),
            **values,
        }

    def _render_preview(self, request, preview):
        result = preview.get("result")
        context = self._import_context(
            request, preview=preview, result=result,
            preview_expires_at=parse_datetime(preview["expiresAt"]),
        )
        context["report_url"] = reverse("admin:writing_writingcontent_import_report", args=(preview["previewId"],))
        if result:
            context["batch_list_url"] = context["changelist_url"] + "?" + urlencode({"import_batch": preview["previewId"]})
            context["content_links"] = [
                {"id": content_id, "url": reverse("admin:writing_writingcontent_preview", args=(content_id,))}
                for content_id in result["contentIds"]
            ]
        return TemplateResponse(request, self.import_template_name, context, status=400 if preview.get("issues") and not result else 200)

    def _import_error(self, request, error):
        preview_id = request.POST.get("preview_id") or request.GET.get("preview_id")
        return TemplateResponse(request, self.import_template_name, self._import_context(
            request, import_error={"code": error.code, "message": error.message},
            retry_preview_url=self._import_url(preview_id) if error.status == 503 and preview_id else None,
        ), status=error.status)

    def _unavailable(self, request):
        return self._import_error(request, WritingImportError(
            "IMPORT_UNAVAILABLE", "导入服务暂时不可用。请稍后重新打开预览核对批次结果，再决定是否重试。", 503,
        ))

    def import_view(self, request):
        if request.method not in ("GET", "POST"):
            return HttpResponseNotAllowed(("GET", "POST"))
        try:
            self._require_import_permission(request)
            if request.method == "GET":
                preview_id = request.GET.get("preview_id")
                if preview_id:
                    return self._render_preview(request, load_preview(preview_id, request.user))
                return TemplateResponse(request, self.import_template_name, self._import_context(request))
            data = request.POST.copy()
            if "mode" not in data:
                data["mode"] = "create_only"
            form = WritingImportUploadForm(data, request.FILES)
            if not form.is_valid():
                return TemplateResponse(request, self.import_template_name, self._import_context(request, form=form), status=400)
            upload = form.cleaned_data["import_file"]
            if upload.size > MAX_UPLOAD_BYTES:
                raise WritingImportError("FILE_TOO_LARGE", "文件超过 5 MiB，请拆分后重新上传。", 400)
            raw = upload.read(MAX_UPLOAD_BYTES + 1)
            if len(raw) > MAX_UPLOAD_BYTES:
                raise WritingImportError("FILE_TOO_LARGE", "文件超过 5 MiB，请拆分后重新上传。", 400)
            parsed = parse_workbook(raw, upload.name)
            preview = build_import_preview(parsed, request.user, form.cleaned_data["mode"])
            preview = save_preview(request.user, raw, preview)
            return self._render_preview(request, preview)
        except WritingImportError as error:
            return self._import_error(request, error)
        except (OSError, DatabaseError):
            return self._unavailable(request)

    def confirm_import_view(self, request):
        if request.method != "POST":
            return HttpResponseNotAllowed(("POST",))
        try:
            self._require_import_permission(request)
            preview_id = request.POST.get("preview_id", "")
            token = request.POST.get("confirmation_token", "")
            if not preview_id or not token:
                raise WritingImportError("INVALID_CONFIRMATION", "确认信息不完整，请重新上传并预览。", 400)
            preview = load_preview(preview_id, request.user, token=token)
            confirm_import(preview, request.user)
            return HttpResponseRedirect(self._import_url(preview_id))
        except WritingImportError as error:
            return self._import_error(request, error)
        except (OSError, DatabaseError):
            return self._unavailable(request)

    def _xlsx_response(self, raw, filename):
        response = HttpResponse(raw, content_type=XLSX_CONTENT_TYPE)
        response["Content-Disposition"] = f'attachment; filename="{filename}"'
        response["Cache-Control"] = "no-store, private"
        response["X-Content-Type-Options"] = "nosniff"
        return response

    def import_template_view(self, request):
        if request.method != "GET":
            return HttpResponseNotAllowed(("GET",))
        try:
            self._require_import_permission(request)
            raw = make_template(
                categories=WritingCategory.objects.order_by("sort_order", "id").values("id", "name", "sort_order", "is_active"),
                genres=WritingGenre.objects.order_by("sort_order", "id").values("id", "name", "sort_order", "is_active"),
            )
            return self._xlsx_response(raw, "writing-import-template.xlsx")
        except WritingImportError as error:
            return self._import_error(request, error)
        except (OSError, DatabaseError):
            return self._unavailable(request)

    def import_report_view(self, request, preview_id):
        if request.method != "GET":
            return HttpResponseNotAllowed(("GET",))
        try:
            self._require_import_permission(request)
            preview = load_preview(str(preview_id), request.user)
            return self._xlsx_response(make_error_report(preview["issues"]), f"writing-import-report-{preview_id}.xlsx")
        except WritingImportError as error:
            return self._import_error(request, error)
        except (OSError, DatabaseError):
            return self._unavailable(request)
