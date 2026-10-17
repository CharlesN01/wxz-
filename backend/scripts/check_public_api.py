"""Read-only production student API smoke check.

The command deliberately uses IDs returned by the live catalog instead of
assuming demo IDs. It never authenticates, writes data, or changes settings.
"""

import argparse
import json
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urljoin
from urllib.request import Request, urlopen


def fetch(base_url, path, timeout):
    url = urljoin(base_url.rstrip("/") + "/", path.lstrip("/"))
    request = Request(url, headers={"Accept": "application/json"})
    try:
        with urlopen(request, timeout=timeout) as response:
            raw = response.read(2 * 1024 * 1024)
            return response.status, json.loads(raw.decode("utf-8")), None
    except HTTPError as error:
        try:
            body = json.loads(error.read(64 * 1024).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            body = {"error": "non_json_response"}
        return error.code, body, None
    except (URLError, TimeoutError, OSError, ValueError) as error:
        return None, None, type(error).__name__


def page_count(payload):
    if not isinstance(payload, dict):
        return None
    value = payload.get("count")
    return value if isinstance(value, int) else None


def first_result(payload):
    rows = payload.get("results") if isinstance(payload, dict) else None
    return rows[0] if isinstance(rows, list) and rows and isinstance(rows[0], dict) else {}


def check(base_url, timeout):
    checks = []
    failures = []
    warnings = []

    def add(name, path, required=True):
        status, payload, error = fetch(base_url, path, timeout)
        item = {"name": name, "path": path, "status": status, "required": required}
        if error:
            item["error"] = error
        elif isinstance(payload, dict):
            item["count"] = page_count(payload)
            if "enabled" in payload:
                item["enabled"] = payload["enabled"]
            if "purchaseAvailable" in payload:
                item["purchaseAvailable"] = payload["purchaseAvailable"]
            if isinstance(payload.get("results"), list):
                item["resultCount"] = len(payload["results"])
            item["firstId"] = payload["results"][0].get("id") if payload.get("results") else None
        checks.append(item)
        return item, payload

    add("healthz", "/healthz")
    _, category_payload = add("categories", "/api/student/v1/categories/")
    articles, article_payload = add("articles", "/api/student/v1/articles/")

    category_id = first_result(category_payload).get("id")
    if category_id:
        add("literature questions", "/api/student/v1/questions/?" + urlencode({
            "source": "literature", "categoryId": category_id, "page": "1",
        }))
    else:
        checks.append({"name": "literature questions", "path": "(skipped: no category)", "status": None, "required": True})

    article_id = first_result(article_payload).get("id")
    if article_id:
        add("classical questions", "/api/student/v1/questions/?" + urlencode({
            "source": "classical", "articleId": article_id, "type": "word", "page": "1",
        }))
    else:
        checks.append({"name": "classical questions", "path": "(skipped: no article)", "status": None, "required": True})

    add("writings", "/api/student/v1/writings/")
    products, product_payload = add("products", "/api/student/v1/products/")
    resources, resources_payload = add("resources", "/api/student/v1/resources/group/", required=False)

    product_rows = (product_payload or {}).get("results", [])
    all_chinese = next((row for row in product_rows if row.get("id") == "all-chinese"), None)
    if all_chinese is None:
        failures.append("all-chinese product is missing")
    elif all_chinese.get("priceFen") != 10:
        failures.append("all-chinese product priceFen is not 10")

    warnings = []
    if resources.get("status") != 200:
        warnings.append("resources endpoint unavailable")
    elif not (resources_payload or {}).get("enabled"):
        warnings.append("group resources are disabled")

    for item in checks:
        if not item["required"]:
            continue
        if item["status"] != 200:
            failures.append(item["name"] + " status=" + str(item["status"]))
        elif item["name"] in {"categories", "articles", "writings", "products"} and item.get("count") == 0:
            failures.append(item["name"] + " is empty")
        elif item["name"] in {"literature questions", "classical questions"} and item.get("count") == 0:
            failures.append(item["name"] + " is empty")
    return checks, failures, warnings


def main():
    parser = argparse.ArgumentParser(description="Read-only production student API check")
    parser.add_argument("--base-url", default="https://zsbzy.com")
    parser.add_argument("--timeout", type=float, default=15)
    args = parser.parse_args()
    checks, failures, warnings = check(args.base_url, args.timeout)
    print(json.dumps({
        "baseUrl": args.base_url.rstrip("/"),
        "checks": checks,
        "failures": failures,
        "warnings": warnings,
    }, ensure_ascii=False, indent=2))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
