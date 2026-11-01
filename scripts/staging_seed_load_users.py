#!/usr/bin/env python3
"""Create synthetic student sessions for the isolated staging load test."""

from __future__ import annotations

import argparse
import base64
import json
import os
import secrets
import sys
import uuid
from datetime import timedelta


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--count", type=int, default=3000)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    if not 1 <= args.count <= 10000:
        raise SystemExit("count must be between 1 and 10000")

    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
    sys.path.insert(0, os.getcwd())
    import django

    django.setup()

    from django.contrib.auth import get_user_model
    from django.db import transaction
    from django.utils import timezone
    from accounts.crypto import encrypt_session_key
    from accounts.models import StudentSession, WeChatIdentity
    from accounts.services import token_digest
    from content.access import published_questions

    User = get_user_model()
    question = published_questions().values_list("pk", flat=True).first()
    if not question:
        raise SystemExit("staging database has no published question")

    prefix = "loadtest-" + uuid.uuid4().hex[:10] + "-"
    session_key = base64.b64encode(b"staging-load-session-key-32bytes").decode("ascii")
    encrypted_key = encrypt_session_key(session_key)
    expires_at = timezone.now() + timedelta(days=2)
    users = [
        User(username=f"{prefix}{index:05d}", password="!", is_active=True)
        for index in range(args.count)
    ]
    with transaction.atomic():
        User.objects.bulk_create(users, batch_size=500)
        identities = [
            WeChatIdentity(
                user=user,
                app_id="staging-load-test",
                openid=f"{prefix}{index:05d}",
                encrypted_session_key=encrypted_key,
            )
            for index, user in enumerate(users)
        ]
        WeChatIdentity.objects.bulk_create(identities, batch_size=500)
        tokens = [secrets.token_urlsafe(32) for _ in users]
        sessions = [
            StudentSession(
                user=user,
                identity=identity,
                token_digest=token_digest(token),
                encrypted_session_key=encrypted_key,
                expires_at=expires_at,
            )
            for user, identity, token in zip(users, identities, tokens)
        ]
        StudentSession.objects.bulk_create(sessions, batch_size=500)

    with open(args.output, "w", encoding="utf-8") as handle:
        json.dump({"tokens": tokens, "questionId": str(question)}, handle)
    print(json.dumps({"count": len(tokens), "questionId": str(question), "output": args.output}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
