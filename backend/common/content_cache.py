"""Best-effort shared cache for public content; database remains authoritative."""
from django.conf import settings
from django.core.cache import cache

PREFIX = "student-content:v1:"
VERSION_KEY = PREFIX + "version"


def get(key):
    if not getattr(settings, "CONTENT_CACHE_ENABLED", False):
        return None
    try:
        return cache.get(PREFIX + str(key))
    except Exception:
        return None


def set(key, value, timeout=None):
    if not getattr(settings, "CONTENT_CACHE_ENABLED", False):
        return False
    try:
        cache.set(PREFIX + str(key), value, timeout or settings.CONTENT_CACHE_TTL_SECONDS)
        return True
    except Exception:
        return False


def delete(key):
    try:
        cache.delete(PREFIX + str(key))
    except Exception:
        pass


def version():
    if not getattr(settings, "CONTENT_CACHE_ENABLED", False):
        return 0
    try:
        value = cache.get(VERSION_KEY)
        return int(value or 0)
    except Exception:
        return 0


def bump():
    try:
        cache.incr(VERSION_KEY)
    except Exception:
        try:
            cache.set(VERSION_KEY, version() + 1, None)
        except Exception:
            pass
