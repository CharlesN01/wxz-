"""Shared presentation for custom admin actions; business checks stay in views."""
from django.utils.html import format_html, format_html_join


def action_link(url, label, *, variant="secondary", new_tab=False):
    if variant not in {"primary", "secondary", "danger"}:
        raise ValueError("Unknown admin action variant")
    if new_tab:
        return format_html(
            '<a class="admin-action admin-action--{}" href="{}" target="_blank" rel="noopener noreferrer">{}</a>',
            variant, url, label,
        )
    return format_html(
        '<a class="admin-action admin-action--{}" href="{}">{}</a>',
        variant, url, label,
    )


def action_group(*links):
    return format_html(
        '<span class="admin-actions">{}</span>',
        format_html_join("", "{}", ((link,) for link in links)),
    )
