import json
from io import BytesIO
from unittest.mock import patch
from urllib.error import HTTPError

from django.test import SimpleTestCase

from scripts.check_public_api import check, fetch


class PublicAPISmokeTests(SimpleTestCase):
    def response(self, payload, status=200):
        response = BytesIO(json.dumps(payload).encode())
        response.status = status
        response.__enter__ = lambda: response
        response.__exit__ = lambda *args: False
        return response

    @patch("scripts.check_public_api.urlopen")
    def test_empty_public_catalog_returns_actionable_failures(self, mocked_urlopen):
        mocked_urlopen.return_value = self.response({"status": "ok"})
        mocked_urlopen.side_effect = [
            self.response({"status": "ok"}),
            self.response({"count": 0, "results": []}),
            self.response({"count": 0, "results": []}),
            self.response({"count": 0, "results": []}),
            self.response({"count": 0, "results": []}),
            self.response({"enabled": False}),
        ]

        checks, failures, warnings = check("https://example.test", 1)

        self.assertIn("categories is empty", failures)
        self.assertIn("all-chinese product is missing", failures)
        self.assertIn("literature questions status=None", failures)
        self.assertEqual(warnings, ["group resources are disabled"])
        self.assertEqual(len(checks), 8)

    @patch("scripts.check_public_api.urlopen")
    def test_questions_use_live_catalog_ids_and_product_checks_do_not_require_payment(self, mocked_urlopen):
        mocked_urlopen.side_effect = [
            self.response({"status": "ok"}),
            self.response({"count": 1, "results": [{"id": "lit-live"}]}),
            self.response({"count": 1, "results": [{"id": "article-live"}]}),
            self.response({"count": 1, "results": [{"id": "q-lit"}]}),
            self.response({"count": 1, "results": [{"id": "q-classical"}]}),
            self.response({"count": 1, "results": [{"id": "writing-1"}]}),
            self.response({"count": 1, "results": [{"id": "all-chinese", "priceFen": 10, "purchaseAvailable": False}]}),
            self.response({"enabled": True}),
        ]

        checks, failures, warnings = check("https://example.test", 1)

        self.assertEqual(failures, [])
        self.assertEqual(warnings, [])
        requested = [call.args[0].full_url for call in mocked_urlopen.call_args_list]
        self.assertTrue(any("categoryId=lit-live" in url for url in requested))
        self.assertTrue(any("articleId=article-live" in url for url in requested))
        self.assertTrue(any(item["name"] == "products" and item["count"] == 1 for item in checks))

    @patch("scripts.check_public_api.urlopen")
    def test_smoke_paginates_catalogs_and_checks_later_scopes_when_first_scope_is_empty(self, mocked_urlopen):
        mocked_urlopen.side_effect = [
            self.response({"status": "ok"}),
            self.response({"count": 2, "results": [{"id": "lit-empty"}]}),
            self.response({"count": 2, "results": [{"id": "lit-live"}]}),
            self.response({"count": 2, "results": [{"id": "article-empty"}]}),
            self.response({"count": 2, "results": [{"id": "article-live"}]}),
            self.response({"count": 0, "results": []}),
            self.response({"count": 1, "results": [{"id": "q-lit"}]}),
            self.response({"count": 0, "results": []}),
            self.response({"count": 1, "results": [{"id": "q-classical"}]}),
            self.response({"count": 1, "results": [{"id": "writing-1"}]}),
            self.response({"count": 1, "results": [{"id": "all-chinese", "priceFen": 10}]}),
            self.response({"enabled": True}),
        ]

        checks, failures, warnings = check("https://example.test", 1)

        self.assertEqual(failures, [])
        self.assertEqual(warnings, [])
        requested = [call.args[0].full_url for call in mocked_urlopen.call_args_list]
        self.assertTrue(any("/categories/?page=2" in url for url in requested))
        self.assertTrue(any("/articles/?page=2" in url for url in requested))
        self.assertTrue(any("categoryId=lit-empty" in url for url in requested))
        self.assertTrue(any("categoryId=lit-live" in url for url in requested))
        self.assertTrue(any("articleId=article-empty" in url for url in requested))
        self.assertTrue(any("articleId=article-live" in url for url in requested))
        self.assertEqual(len(checks), 12)

    @patch("scripts.check_public_api.urlopen")
    def test_endpoint_http_error_keeps_status_for_diagnosis(self, mocked_urlopen):
        mocked_urlopen.side_effect = [
            HTTPError("https://example.test/healthz", 503, "unavailable", {}, BytesIO(b'{"error":"secret detail"}')),
        ]

        status, payload, error = fetch("https://example.test", "/healthz", 1)

        self.assertEqual(status, 503)
        self.assertEqual(error, None)
        self.assertEqual(payload, {"error": "secret detail"})
