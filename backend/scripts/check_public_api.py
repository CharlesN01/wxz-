"""Read-only production student API smoke check.

The command deliberately uses IDs returned by the live catalog instead of
assuming demo IDs. It never authenticates, writes data, or changes settings.
"""

import argparse
import json
import math
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
                item["firstId"] = payload["results"][0].get("id") if payload["results"] else None
        checks.append(item)
        return item, payload

    def catalog_rows(name, path, payload):
        rows = payload.get("results", []) if isinstance(payload, dict) else []
        rows = [row for row in rows if isinstance(row, dict)]
        total = page_count(payload)
        page_size = len(rows)
        if total is None or total <= page_size:
            return rows
        if page_size == 0:
            failures.append(f"{name} pagination returned no rows despite count={total}")
            return rows

        page_count_expected = math.ceil(total / page_size)
        for page_number in range(2, page_count_expected + 1):
            separator = "&" if "?" in path else "?"
            page_path = f"{path}{separator}{urlencode({'page': page_number})}"
            item, page_payload = add(f"{name} page {page_number}", page_path)
            page_rows = page_payload.get("results", []) if isinstance(page_payload, dict) else []
            rows.extend(row for row in page_rows if isinstance(row, dict))
            if item["status"] != 200:
                break
        if len(rows) < total:
            failures.append(f"{name} pagination incomplete: expected={total} received={len(rows)}")
        return rows

    def has_questions(name, source, scopes, scope_parameter):
        if not scopes:
            checks.append({
                "name": name,
                "path": f"(skipped: no {scope_parameter})",
                "status": None,
                "required": True,
            })
            return

        for scope in scopes:
            scope_id = scope.get("id")
            if not scope_id:
                continue
            query = {"source": source, scope_parameter: scope_id, "page": "1"}
            item, payload = add(
                name,
                "/api/student/v1/questions/?" + urlencode(query),
            )
            if item["status"] == 200 and (page_count(payload) or 0) > 0:
                return
        failures.append(f"{name} is empty across {len(scopes)} {scope_parameter} values")

    add("healthz", "/healthz")
    _, category_payload = add("categories", "/api/student/v1/categories/")
    categories = catalog_rows("categories", "/api/student/v1/categories/", category_payload)
    _, article_payload = add("articles", "/api/student/v1/articles/")
    articles = catalog_rows("articles", "/api/student/v1/articles/", article_payload)

    has_questions("literature questions", "literature", categories, "categoryId")
    has_questions("classical questions", "classical", articles, "articleId")

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
